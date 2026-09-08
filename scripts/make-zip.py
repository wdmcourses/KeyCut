import os
import stat
import sys
import zipfile


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
            zf.write(p, rel, zipfile.ZIP_DEFLATED)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
        add_dir(zf, src, src)


main()