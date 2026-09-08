import os
import stat
import sys
import zipfile

MACHO = (b'\xca\xfe\xba\xbe', b'\xfe\xed\xfa\xce', b'\xfe\xed\xfa\xcf')


def is_exec(p):
    try:
        with open(p, 'rb') as f:
            b = f.read(4)
        if b[:4] == b'\x7fELF':
            return True
        for m in MACHO:
            if b[:4] == m or b[:4] == m[::-1]:
                return True
    except OSError:
        pass
    return False


def add_dir(zf, base, root):
    for entry in sorted(os.listdir(base)):
        p = os.path.join(base, entry)
        rel = os.path.relpath(p, root).replace(os.sep, '/')
        if os.path.islink(p):
            info = zipfile.ZipInfo(rel)
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, os.readlink(p).replace('\\', '/'))
        elif os.path.isdir(p):
            add_dir(zf, p, root)
        else:
            info = zipfile.ZipInfo(rel)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            mode = 0o755 if is_exec(p) else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            with zf.open(info, 'w') as out:
                with open(p, 'rb') as f:
                    while True:
                        chunk = f.read(1048576)
                        if not chunk:
                            break
                        out.write(chunk)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
        add_dir(zf, src, src)


main()