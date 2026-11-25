"""Exercise the production worker without a Claude account or network."""
import os
from pathlib import Path
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import time

WORKER = str(Path(__file__).resolve().parents[1] / "remote" / "worker.py")


def expect(pipe, marker):
    output = bytearray()
    deadline = time.monotonic() + 7
    while marker not in output:
        ready, _, _ = select.select([pipe], [], [], max(0, deadline - time.monotonic()))
        assert ready, "terminal did not produce " + repr(marker)
        chunk = os.read(pipe.fileno(), 65536)
        assert chunk, "terminal closed before " + repr(marker)
        output.extend(chunk)


def send(proc, kind, data):
    proc.stdin.write(struct.pack("!BI", kind, len(data)) + data)
    proc.stdin.flush()


with tempfile.TemporaryDirectory() as home:
    cli = Path(home, "claude")
    shutil.copyfile(Path(__file__).parent / "fixtures" / "terminal.py", cli)
    cli.chmod(0o700)
    env = {**os.environ, "HOME": home, "TMUX_TMPDIR": home, "TERM": "xterm-256color",
           "PATH": home + ":" + os.environ["PATH"]}
    env.pop("TMUX", None)

    def launch(mode):
        return subprocess.Popen([sys.executable, "-I", WORKER, mode], env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE)

    server = launch("serve")
    terminals = []
    try:
        first = launch("attach")
        terminals.append(first)
        expect(first.stdout, b"ready-for-input")
        send(first, 1, struct.pack("!HH", 96, 30))
        # tmux processes window changes asynchronously.
        time.sleep(0.3)
        send(first, 0, "café\r".encode())
        expect(first.stdout, "reply=café size=96x".encode())
        first.stdin.close()
        assert first.wait(timeout=5) == 0
        second = launch("attach")
        terminals.append(second)
        expect(second.stdout, "reply=café".encode())
        send(second, 0, b"finish\r")
        assert server.wait(timeout=5) == 0
        assert second.wait(timeout=5) == 0
    finally:
        subprocess.run(["tmux", "kill-server"], env=env, stderr=subprocess.DEVNULL)
        for proc in [*terminals, server]:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
