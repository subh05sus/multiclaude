#!/usr/bin/env python3
"""Interactive stand-in for the Claude binary in terminal transport tests."""
import os

print("Mock Claude (offline) — ready-for-input " + str(os.getpid()), flush=True)
while True:
    msg = input()
    if msg == "finish":
        break
    size = os.get_terminal_size()
    print(f"reply={msg} size={size.columns}x{size.lines}", flush=True)
