"""Container entry point and framed stdin bridge for one tmux attachment."""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import sys
import termios
import time

TMUX = ["tmux", "-f", "/dev/null"]


def attach():
    # podman run -d can return before the first tmux session exists.
    for _ in range(100):
        if subprocess.run(TMUX + ["has-session", "-t", "=mc"],
                          stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.05)
    pid, terminal = pty.fork()
    if pid == 0:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
        os.execvp("tmux", TMUX + ["attach-session", "-d", "-t", "=mc"])
    pending = bytearray()
    try:
        while True:
            ready, _, _ = select.select([0, terminal], [], [])
            if terminal in ready:
                try:
                    chunk = os.read(terminal, 16384)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            if 0 in ready:
                chunk = os.read(0, 65536)
                if not chunk:
                    return
                pending.extend(chunk)
                while len(pending) >= 5:
                    kind, size = struct.unpack_from("!BI", pending)
                    if size > 65536:
                        raise ValueError("oversized frame")
                    if len(pending) < size + 5:
                        break
                    data = bytes(pending[5:5 + size])
                    del pending[:5 + size]
                    if kind == 1:
                        cols, rows = struct.unpack("!HH", data)
                        fcntl.ioctl(terminal, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
                    elif kind == 0:
                        while data:
                            data = data[os.write(terminal, data):]
                    else:
                        raise ValueError("invalid frame")
    finally:
        os.close(terminal)
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        _, status = os.waitpid(pid, 0)
    if os.WIFEXITED(status) and os.WEXITSTATUS(status):
        raise SystemExit(os.WEXITSTATUS(status))


def main():
    os.umask(0o077)
    workspace = os.path.expanduser("~/workspace")
    os.makedirs(workspace, exist_ok=True)
    os.chdir(workspace)
    mode = sys.argv[1]
    if mode == "login":
        os.execvp("claude", ["claude", "auth", "login"])
    if mode == "attach":
        attach()
    elif mode == "serve":
        subprocess.run(TMUX + ["new-session", "-d", "-s", "mc", "claude"], check=True)
        while subprocess.run(TMUX + ["has-session", "-t", "=mc"], stderr=subprocess.DEVNULL).returncode == 0:
            time.sleep(0.5)
    else:
        raise ValueError("unknown mode")


if __name__ == "__main__":
    main()
