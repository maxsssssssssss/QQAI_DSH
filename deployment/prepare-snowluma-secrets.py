#!/usr/bin/env python3
"""Create the first-start WebUI password once, without displaying it."""
import os
from pathlib import Path
import secrets
import stat

if os.geteuid() != 0:
    raise SystemExit('Run as root on the verified deployment host')
os.umask(0o077)
directory = Path('/etc/qqai-dsh')
if directory.is_symlink():
    raise SystemExit('Credential directory must not be a symlink')
directory.mkdir(mode=0o700, exist_ok=True)
directory.chmod(0o700)
path = directory / 'snowluma.env'
if path.exists():
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600:
        raise SystemExit('Existing credential must be a root-owned regular 0600 file')
    print('Existing protected SnowLuma bootstrap credential retained.')
else:
    password = 'Aa9!' + secrets.token_urlsafe(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write('SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD=' + password + '\n')
    print('Generated a protected SnowLuma bootstrap credential; value not displayed.')
