import os
import sys
import tarfile

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


def add_dir(tf, base, root, prefix):
    for entry in sorted(os.listdir(base)):
        p = os.path.join(base, entry)
        rel = os.path.relpath(p, root).replace(os.sep, '/')
        name = prefix + '/' + rel
        if os.path.islink(p):
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = os.readlink(p).replace('\\', '/')
            info.mode = 0o777
            info.size = 0
            tf.addfile(info)
        elif os.path.isdir(p):
            info = tf.gettarinfo(p, arcname=name)
            info.mode = 0o755
            tf.addfile(info, None)
            add_dir(tf, p, root, prefix)
        else:
            info = tf.gettarinfo(p, arcname=name)
            info.mode = 0o755 if is_exec(p) else 0o644
            with open(p, 'rb') as f:
                tf.addfile(info, f)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    prefix = os.path.basename(src.rstrip('/\\'))
    with tarfile.open(dst, 'w:gz') as tf:
        add_dir(tf, src, src, prefix)


main()