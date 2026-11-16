// Linux acceptance probe for the SQLite driver used in the panel image.
// cc -O2 -Wall -Werror -shared -fPIC receipt-sqlite-power.c -o probe.so -ldl
// Preload only in the dedicated receipt-volume-full.cjs commit worker.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void pause_failed_database_write(int fd) {
    char link[64], target[256];
    snprintf(link, sizeof(link), "/proc/self/fd/%d", fd);
    ssize_t size = readlink(link, target, sizeof(target) - 1);
    if (size < 0) return;
    target[size] = '\0';
    if (strcmp(target, "/ql/data/db/database.sqlite") != 0 ||
        access("/ql/data/db/.qa-isolated-volume", F_OK) != 0) return;

    // The control file is on a different filesystem from the full database.
    int barrier = open("/tmp/journal-qa/native-full", O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (barrier < 0) return;
    dprintf(barrier, "{\"syscall\":\"write\",\"errno\":%d,\"pid\":%d}", ENOSPC, getpid());
    close(barrier);
    raise(SIGSTOP);
}

ssize_t write(int fd, const void *bytes, size_t length) {
    // Call the kernel first so the fault is an actual filesystem response.
    ssize_t (*real_write)(int, const void *, size_t) = dlsym(RTLD_NEXT, "write");
    ssize_t written = real_write(fd, bytes, length);
    int saved_errno = errno;
    if (written < 0 && saved_errno == ENOSPC) pause_failed_database_write(fd);
    errno = saved_errno;
    return written;
}
