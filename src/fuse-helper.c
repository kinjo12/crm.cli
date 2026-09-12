/**
 * CRM FUSE3 thin shim.
 *
 * Handles FUSE3 syscalls and forwards all data operations to the TS daemon
 * over a Unix domain socket. All business logic lives in fuse-daemon.ts.
 *
 * Compiled with: gcc -o crm-fuse src/fuse-helper.c $(pkg-config --cflags --libs fuse3)
 * Usage: crm-fuse -f <mountpoint> -- <socket-path>
 */
#define FUSE_USE_VERSION 35
#include <fuse3/fuse.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <pthread.h>

static char g_socket_path[4096];

/* ── Socket communication ── */

static int sock_connect(void) {
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strncpy(addr.sun_path, g_socket_path, sizeof(addr.sun_path) - 1);
    if (connect(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        close(fd);
        return -1;
    }
    return fd;
}

/*
 * Send a request line and read the response line.
 * Returns a malloc'd string (caller must free) or NULL on error.
 */
static char *sock_request(const char *request) {
    int fd = sock_connect();
    if (fd < 0) return NULL;

    /* Send request + newline */
    size_t reqlen = strlen(request);
    char *reqbuf = malloc(reqlen + 2);
    if (!reqbuf) { close(fd); return NULL; }
    memcpy(reqbuf, request, reqlen);
    reqbuf[reqlen] = '\n';
    reqbuf[reqlen + 1] = '\0';

    ssize_t sent = 0;
    while ((size_t)sent < reqlen + 1) {
        ssize_t n = write(fd, reqbuf + sent, reqlen + 1 - sent);
        if (n <= 0) { free(reqbuf); close(fd); return NULL; }
        sent += n;
    }
    free(reqbuf);

    /* Read response until newline */
    size_t cap = 65536;
    char *resp = malloc(cap);
    if (!resp) { close(fd); return NULL; }
    size_t len = 0;
    while (1) {
        if (len >= cap - 1) {
            cap *= 2;
            char *tmp = realloc(resp, cap);
            if (!tmp) { free(resp); close(fd); return NULL; }
            resp = tmp;
        }
        ssize_t n = read(fd, resp + len, cap - len - 1);
        if (n <= 0) break;
        len += n;
        resp[len] = '\0';
        if (memchr(resp + len - n, '\n', n)) break;
    }
    close(fd);

    /* Trim trailing newline */
    while (len > 0 && (resp[len-1] == '\n' || resp[len-1] == '\r')) {
        resp[--len] = '\0';
    }
    return resp;
}

/* ── Minimal JSON helpers ── */

static const char *json_find_key(const char *json, const char *key) {
    char pattern[256];
    snprintf(pattern, sizeof(pattern), "\"%s\":", key);
    const char *p = strstr(json, pattern);
    if (!p) return NULL;
    p += strlen(pattern);
    while (*p == ' ' || *p == '\t') p++;
    return p;
}

static char *json_get_string(const char *json, const char *key) {
    const char *v = json_find_key(json, key);
    if (!v || *v != '"') return NULL;
    v++;
    const char *end = v;
    while (*end && *end != '"') {
        if (*end == '\\') end++;
        if (*end) end++;
    }
    size_t len = end - v;
    char *s = malloc(len + 1);
    if (!s) return NULL;
    size_t j = 0;
    for (size_t i = 0; i < len; i++) {
        if (v[i] == '\\' && i + 1 < len) {
            i++;
            if (v[i] == 'n') s[j++] = '\n';
            else if (v[i] == 't') s[j++] = '\t';
            else if (v[i] == 'r') s[j++] = '\r';
            else s[j++] = v[i];
        } else {
            s[j++] = v[i];
        }
    }
    s[j] = '\0';
    return s;
}

static int json_has_error(const char *json) {
    return json_find_key(json, "error") != NULL;
}

static int json_get_errno(const char *json) {
    char *err = json_get_string(json, "error");
    if (!err) return EIO;
    int code = EIO;
    if (strcmp(err, "ENOENT") == 0) code = ENOENT;
    else if (strcmp(err, "EINVAL") == 0) code = EINVAL;
    else if (strcmp(err, "EPERM") == 0) code = EPERM;
    else if (strcmp(err, "EROFS") == 0) code = EROFS;
    else if (strcmp(err, "ENOSYS") == 0) code = ENOSYS;
    free(err);
    return code;
}

static int json_is_type(const char *json, const char *type) {
    char *t = json_get_string(json, "type");
    if (!t) return 0;
    int match = strcmp(t, type) == 0;
    free(t);
    return match;
}

static int64_t json_get_int64(const char *json, const char *key, int64_t default_val) {
    const char *v = json_find_key(json, key);
    if (!v) return default_val;
    /* Skip whitespace */
    while (*v == ' ' || *v == '\t') v++;
    /* Must start with a digit */
    if (*v < '0' || *v > '9') return default_val;
    return (int64_t)strtoll(v, NULL, 10);
}

/*
 * Escape `s` as a complete, double-quoted JSON string (including the
 * surrounding quotes) into `buf`. Escapes '"', '\\', and every control byte
 * 0x00-0x1F: the five with short escapes (\", \\, \n, \r, \t) and every
 * other control byte via the standard \u00XX form, per RFC 8259 (raw control
 * bytes are illegal inside a JSON string). `s` itself can never actually
 * contain a 0x00 byte (it's NUL-terminated), so in practice this covers
 * 0x01-0x1F.
 *
 * `maxlen` is the total size of `buf`, including room for the terminating
 * NUL. On success, returns the number of bytes written excluding the NUL
 * (i.e. strlen(buf)), matching this file's other snprintf-based helpers. If
 * the escaped output (plus quotes and NUL) would not fit in `maxlen`,
 * returns (size_t)-1 and leaves `buf`'s contents unspecified — callers MUST
 * check for this sentinel rather than assuming truncated output is still
 * usable.
 */
static size_t json_escape(char *buf, size_t maxlen, const char *s) {
    size_t p = 0;

    /* Writes one byte, failing (returning early from json_escape) if doing
     * so wouldn't leave room for a terminating NUL afterward. */
#define JSON_ESCAPE_PUT(ch) \
    do { \
        if (p + 1 >= maxlen) return (size_t)-1; \
        buf[p++] = (char)(ch); \
    } while (0)

    JSON_ESCAPE_PUT('"');
    for (size_t i = 0; s[i]; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') {
            JSON_ESCAPE_PUT('\\'); JSON_ESCAPE_PUT(c);
        } else if (c == '\n') {
            JSON_ESCAPE_PUT('\\'); JSON_ESCAPE_PUT('n');
        } else if (c == '\r') {
            JSON_ESCAPE_PUT('\\'); JSON_ESCAPE_PUT('r');
        } else if (c == '\t') {
            JSON_ESCAPE_PUT('\\'); JSON_ESCAPE_PUT('t');
        } else if (c < 0x20) {
            char esc[7];
            snprintf(esc, sizeof(esc), "\\u%04x", c);
            for (int k = 0; k < 6; k++) JSON_ESCAPE_PUT(esc[k]);
        } else {
            JSON_ESCAPE_PUT(c);
        }
    }
    JSON_ESCAPE_PUT('"');
    buf[p] = '\0';

#undef JSON_ESCAPE_PUT
    return p;
}

/*
 * Build a request of the form {"op":"<op>","path":"<escaped path>"}.
 * Used by getattr/readdir/read/unlink, whose requests only ever interpolate
 * `path` (never raw — always through json_escape()). `path` comes straight
 * from the kernel and, per FUSE semantics, may contain any byte except NUL
 * and '/' (including '"', '\', and control characters), so it must never be
 * interpolated unescaped into the JSON we hand-build here.
 *
 * The buffer is sized dynamically off strlen(path) rather than using a
 * fixed-size stack buffer: json_escape() can expand its input by up to
 * 6x+2 bytes (every byte becomes a \u00XX escape), so a fixed buffer could
 * overflow or silently truncate a long or heavily-escaped path into a
 * different, valid-but-wrong request.
 *
 * Returns a malloc'd string (caller must free), or NULL on allocation
 * failure OR if json_escape() reports it could not fit the escaped path
 * within the buffer computed below (which should never happen given the
 * sizing formula, but is checked defensively — see json_escape()'s
 * contract). Either way, callers already treat a NULL return as -ENOMEM.
 */
static char *build_path_request(const char *op, const char *path) {
    size_t path_escaped_max = strlen(path) * 6 + 3; /* worst case: every byte \u00XX-escaped, plus quotes */
    size_t reqsize = strlen(op) + path_escaped_max + 128;
    char *req = malloc(reqsize);
    if (!req) return NULL;

    size_t rp = 0;
    rp += (size_t)snprintf(req + rp, reqsize - rp, "{\"op\":\"%s\",\"path\":", op);
    size_t escaped = json_escape(req + rp, reqsize - rp, path);
    if (escaped == (size_t)-1) {
        free(req);
        return NULL;
    }
    rp += escaped;
    snprintf(req + rp, reqsize - rp, "}");
    return req;
}

/*
 * Build a request of the form
 * {"op":"write","path":"<escaped path>","data":"<escaped data>"}.
 * Used by crm_write/crm_flush, whose requests interpolate both `path` and
 * the buffered file contents (`data`) — never raw, always through
 * json_escape(). Just like `path` (see build_path_request()'s doc comment),
 * `data` is attacker/user-controlled file content and must never be
 * interpolated unescaped into the JSON we hand-build here.
 *
 * `len` is the length of `data` used purely for sizing the escape buffer
 * (matching the write buffer's tracked length, `wb->len`); `data` itself
 * must still be NUL-terminated, since json_escape() walks it via its own
 * NUL terminator rather than `len`.
 *
 * The buffer is sized dynamically off strlen(path) and `len` rather than
 * using a fixed-size stack buffer, for the same reason as
 * build_path_request(): json_escape() can expand its input by up to 6x+2
 * bytes (every byte becomes a \u00XX escape), so a fixed buffer could
 * overflow or silently truncate a long or heavily-escaped path/data into a
 * different, valid-but-wrong request.
 *
 * Returns a malloc'd string (caller must free), or NULL on allocation
 * failure OR if json_escape() reports it could not fit the escaped path or
 * escaped data within the buffer computed below (which should never happen
 * given the sizing formula, but is checked defensively — see
 * json_escape()'s contract). Either way, callers already treat a NULL
 * return uniformly as -ENOMEM, matching precedent from build_path_request's
 * 4 callers.
 *
 * This function touches no shared state and does no locking — callers
 * (crm_write/crm_flush) are responsible for holding g_write_mutex while
 * reading `path`/`data`/`len` from the write buffer before calling this.
 */
static char *build_write_request(const char *path, const char *data, size_t len) {
    size_t path_escaped_max = strlen(path) * 6 + 3; /* worst case: every byte \u00XX-escaped, plus quotes */
    size_t data_escaped_max = len * 6 + 3;
    size_t reqsize = path_escaped_max + data_escaped_max + 128;
    char *req = malloc(reqsize);
    if (!req) return NULL;

    size_t rp = 0;
    rp += (size_t)snprintf(req + rp, reqsize - rp, "{\"op\":\"write\",\"path\":");
    size_t path_escaped = json_escape(req + rp, reqsize - rp, path);
    if (path_escaped == (size_t)-1) {
        free(req);
        return NULL;
    }
    rp += path_escaped;
    rp += (size_t)snprintf(req + rp, reqsize - rp, ",\"data\":");
    size_t data_escaped = json_escape(req + rp, reqsize - rp, data);
    if (data_escaped == (size_t)-1) {
        free(req);
        return NULL;
    }
    rp += data_escaped;
    snprintf(req + rp, reqsize - rp, "}");
    return req;
}

static char **json_get_entries(const char *json, int *count) {
    *count = 0;
    const char *v = json_find_key(json, "entries");
    if (!v || *v != '[') return NULL;
    v++;

    int cap = 64;
    char **entries = malloc(sizeof(char *) * cap);
    if (!entries) return NULL;

    while (*v) {
        while (*v == ' ' || *v == ',' || *v == '\t' || *v == '\n') v++;
        if (*v == ']') break;
        if (*v != '"') { v++; continue; }
        v++;
        const char *end = v;
        while (*end && *end != '"') {
            if (*end == '\\') end++;
            if (*end) end++;
        }
        size_t len = end - v;
        if (*count >= cap - 1) {
            cap *= 2;
            entries = realloc(entries, sizeof(char *) * cap);
        }
        entries[*count] = malloc(len + 1);
        memcpy(entries[*count], v, len);
        entries[*count][len] = '\0';
        (*count)++;
        v = end;
        if (*v == '"') v++;
    }
    entries[*count] = NULL;
    return entries;
}

static char *json_get_data(const char *json) {
    return json_get_string(json, "data");
}

/* ── Write buffer management ── */
#define MAX_WRITE_BUFS 64

struct write_buf {
    char path[4096];
    char *data;
    size_t len;
    size_t cap;
    int active;
    int committed; /* 1 if data has been sent to daemon and accepted */
};

static struct write_buf g_write_bufs[MAX_WRITE_BUFS];
static pthread_mutex_t g_write_mutex = PTHREAD_MUTEX_INITIALIZER;

static struct write_buf *find_write_buf(const char *path) {
    for (int i = 0; i < MAX_WRITE_BUFS; i++) {
        if (g_write_bufs[i].active && strcmp(g_write_bufs[i].path, path) == 0)
            return &g_write_bufs[i];
    }
    return NULL;
}

static struct write_buf *alloc_write_buf(const char *path) {
    for (int i = 0; i < MAX_WRITE_BUFS; i++) {
        if (!g_write_bufs[i].active) {
            g_write_bufs[i].active = 1;
            strncpy(g_write_bufs[i].path, path, sizeof(g_write_bufs[i].path) - 1);
            g_write_bufs[i].path[sizeof(g_write_bufs[i].path) - 1] = '\0';
            g_write_bufs[i].cap = 65536;
            g_write_bufs[i].data = malloc(g_write_bufs[i].cap);
            g_write_bufs[i].len = 0;
            g_write_bufs[i].committed = 0;
            if (g_write_bufs[i].data) g_write_bufs[i].data[0] = '\0';
            return &g_write_bufs[i];
        }
    }
    return NULL;
}

static void free_write_buf(struct write_buf *wb) {
    if (wb->data) free(wb->data);
    wb->data = NULL;
    wb->len = 0;
    wb->cap = 0;
    wb->active = 0;
}

/* ── FUSE operations ── */

static int crm_getattr(const char *path, struct stat *stbuf,
                        struct fuse_file_info *fi) {
    (void)fi;
    memset(stbuf, 0, sizeof(struct stat));

    char *req = build_path_request("getattr", path);
    if (!req) return -ENOMEM;

    char *resp = sock_request(req);
    free(req);
    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        return -err;
    }

    if (json_is_type(resp, "dir")) {
        stbuf->st_mode = S_IFDIR | 0755;
        stbuf->st_nlink = 2;
    } else {
        stbuf->st_mode = S_IFREG | 0644;
        stbuf->st_nlink = 1;
        stbuf->st_size = (off_t)json_get_int64(resp, "size", 65536);
    }

    free(resp);
    return 0;
}

static int crm_readdir(const char *path, void *buf, fuse_fill_dir_t filler,
                        off_t offset, struct fuse_file_info *fi,
                        enum fuse_readdir_flags flags) {
    (void)offset; (void)fi; (void)flags;

    filler(buf, ".", NULL, 0, 0);
    filler(buf, "..", NULL, 0, 0);

    char *req = build_path_request("readdir", path);
    if (!req) return -ENOMEM;

    char *resp = sock_request(req);
    free(req);
    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        return -err;
    }

    int count = 0;
    char **entries = json_get_entries(resp, &count);
    free(resp);

    if (entries) {
        for (int i = 0; i < count; i++) {
            filler(buf, entries[i], NULL, 0, 0);
            free(entries[i]);
        }
        free(entries);
    }

    return 0;
}

static int crm_open(const char *path, struct fuse_file_info *fi) {
    (void)path;
    /* Bypass the VFS page cache so every read goes straight to crm_read.
     * This ensures the kernel never serves stale zero-padded pages when
     * st_size > actual content length (common with dynamic FUSE files). */
    fi->direct_io = 1;
    return 0;
}

static int crm_read(const char *path, char *buf, size_t size, off_t offset,
                     struct fuse_file_info *fi) {
    (void)fi;

    char *req = build_path_request("read", path);
    if (!req) return -ENOMEM;

    char *resp = sock_request(req);
    free(req);
    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        return -err;
    }

    char *data = json_get_data(resp);
    free(resp);
    if (!data) return -EIO;

    size_t content_len = strlen(data);
    if ((size_t)offset >= content_len) {
        free(data);
        return 0;
    }
    if (offset + size > content_len) size = content_len - offset;
    memcpy(buf, data + offset, size);
    free(data);
    return size;
}

static int crm_create(const char *path, mode_t mode, struct fuse_file_info *fi) {
    (void)mode; (void)fi;

    pthread_mutex_lock(&g_write_mutex);
    struct write_buf *wb = find_write_buf(path);
    if (!wb) wb = alloc_write_buf(path);
    pthread_mutex_unlock(&g_write_mutex);

    return wb ? 0 : -ENOMEM;
}

static int crm_truncate(const char *path, off_t size, struct fuse_file_info *fi) {
    (void)fi;

    pthread_mutex_lock(&g_write_mutex);
    struct write_buf *wb = find_write_buf(path);
    if (!wb) wb = alloc_write_buf(path);
    if (wb) {
        wb->len = (size_t)size;
        if (wb->data && wb->len < wb->cap) wb->data[wb->len] = '\0';
    }
    pthread_mutex_unlock(&g_write_mutex);

    return wb ? 0 : -ENOMEM;
}

static int crm_write(const char *path, const char *data, size_t size,
                      off_t offset, struct fuse_file_info *fi) {
    (void)fi;

    pthread_mutex_lock(&g_write_mutex);
    struct write_buf *wb = find_write_buf(path);
    if (!wb) wb = alloc_write_buf(path);
    if (!wb) {
        pthread_mutex_unlock(&g_write_mutex);
        return -ENOMEM;
    }

    size_t end = (size_t)offset + size;
    if (end >= wb->cap) {
        size_t newcap = wb->cap;
        while (newcap <= end) newcap *= 2;
        char *tmp = realloc(wb->data, newcap);
        if (!tmp) {
            pthread_mutex_unlock(&g_write_mutex);
            return -ENOMEM;
        }
        wb->data = tmp;
        wb->cap = newcap;
    }

    memcpy(wb->data + offset, data, size);
    if (end > wb->len) wb->len = end;
    wb->data[wb->len] = '\0';
    wb->committed = 0;

    /* Send data to daemon immediately for validation + persistence.
     * Bun's writeFileSync doesn't check close() errors, so we must
     * validate here in the write() syscall where errors propagate. */
    char *req = build_write_request(path, wb->data, wb->len);
    if (!req) {
        pthread_mutex_unlock(&g_write_mutex);
        return -ENOMEM;
    }

    pthread_mutex_unlock(&g_write_mutex);

    char *resp = sock_request(req);
    free(req);

    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        /* Clear the buffer so flush doesn't re-send bad data */
        pthread_mutex_lock(&g_write_mutex);
        wb = find_write_buf(path);
        if (wb) { wb->len = 0; wb->committed = 0; }
        pthread_mutex_unlock(&g_write_mutex);
        return -err;
    }

    free(resp);
    pthread_mutex_lock(&g_write_mutex);
    wb = find_write_buf(path);
    if (wb) wb->committed = 1;
    pthread_mutex_unlock(&g_write_mutex);

    return (int)size;
}

static int crm_flush(const char *path, struct fuse_file_info *fi) {
    (void)fi;

    pthread_mutex_lock(&g_write_mutex);
    struct write_buf *wb = find_write_buf(path);
    if (!wb || wb->len == 0 || wb->committed) {
        pthread_mutex_unlock(&g_write_mutex);
        return 0;
    }

    /* Send uncommitted data to daemon (fallback for multi-chunk writes). */
    char *req = build_write_request(path, wb->data, wb->len);
    if (!req) {
        pthread_mutex_unlock(&g_write_mutex);
        return -ENOMEM;
    }

    pthread_mutex_unlock(&g_write_mutex);

    char *resp = sock_request(req);
    free(req);

    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        return -err;
    }

    free(resp);
    return 0;
}

static int crm_release(const char *path, struct fuse_file_info *fi) {
    (void)fi;

    pthread_mutex_lock(&g_write_mutex);
    struct write_buf *wb = find_write_buf(path);
    if (wb) free_write_buf(wb);
    pthread_mutex_unlock(&g_write_mutex);

    return 0;
}

static int crm_unlink(const char *path) {
    char *req = build_path_request("unlink", path);
    if (!req) return -ENOMEM;

    char *resp = sock_request(req);
    free(req);
    if (!resp) return -EIO;

    if (json_has_error(resp)) {
        int err = json_get_errno(resp);
        free(resp);
        return -err;
    }

    free(resp);
    return 0;
}

static const struct fuse_operations crm_ops = {
    .getattr  = crm_getattr,
    .readdir  = crm_readdir,
    .open     = crm_open,
    .read     = crm_read,
    .create   = crm_create,
    .truncate = crm_truncate,
    .write    = crm_write,
    .flush    = crm_flush,
    .release  = crm_release,
    .unlink   = crm_unlink,
};

int main(int argc, char *argv[]) {
    /* Find socket path after "--" separator
     * Usage: crm-fuse -f <mountpoint> [fuse-opts] -- <socket-path> */
    int fuse_argc = argc;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--") == 0) {
            if (i + 1 < argc) {
                strncpy(g_socket_path, argv[i + 1], sizeof(g_socket_path) - 1);
            }
            fuse_argc = i;
            break;
        }
    }

    if (!g_socket_path[0]) {
        fprintf(stderr, "Usage: crm-fuse -f <mountpoint> [opts] -- <socket-path>\n");
        return 1;
    }

    memset(g_write_bufs, 0, sizeof(g_write_bufs));

    return fuse_main(fuse_argc, argv, &crm_ops, NULL);
}
