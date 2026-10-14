// Afterhours launcher: the program the LaunchAgent starts and the one you give Full Disk
// Access. It runs `cq` (next to it) as a child, and macOS credits a child's file access to
// the process that started it. This file never changes, so rebuilding cq keeps the permission.
#include <errno.h>
#include <libgen.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;
static pid_t child = -1;

static void forward(int sig) {
  if (child > 0) kill(child, sig);
}

int main(int argc, char *argv[]) {
  char self[PATH_MAX], real[PATH_MAX], target[PATH_MAX];
  uint32_t size = sizeof(self);
  if (_NSGetExecutablePath(self, &size) != 0 || !realpath(self, real)) {
    fprintf(stderr, "cq-launcher: can't locate itself\n");
    return 70;
  }
  snprintf(target, sizeof(target), "%s/cq", dirname(real));

  // cq-launcher [args...] runs `cq args...`; with no arguments, `cq daemon`.
  char *args[argc + 2];
  int n = 0;
  args[n++] = target;
  if (argc > 1) {
    for (int i = 1; i < argc; i++) args[n++] = argv[i];
  } else {
    args[n++] = "daemon";
  }
  args[n] = NULL;

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = forward;
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGINT, &sa, NULL);
  sigaction(SIGHUP, &sa, NULL);

  int err = posix_spawn(&child, target, NULL, NULL, args, environ);
  if (err != 0) {
    fprintf(stderr, "cq-launcher: can't start %s: %s\n", target, strerror(err));
    return 70;
  }
  int status;
  while (waitpid(child, &status, 0) < 0) {
    if (errno != EINTR) return 70;
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 70;
}
