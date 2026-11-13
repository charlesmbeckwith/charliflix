"""Exercise the ELF gate with small in-memory fixtures, including corrupt input."""
import struct
import unittest

from audit import audit_elf


def elf(needed=('libc.so',), alignment=16384):
    data = bytearray(2048)
    ident = b'\x7fELF\x02\x01\x01' + bytes(9)
    struct.pack_into('<16sHHIQQQIHHHHHH', data, 0, ident, 3, 183, 1,
                     0, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, 0, 0, 0, len(data), len(data), alignment)
    strings = b'\0'
    dynamic = []
    for name in needed:
        dynamic.append((1, len(strings)))
        strings += name.encode('ascii') + b'\0'
    dynamic.extend([(5, 1024), (10, len(strings)), (0, 0)])
    struct.pack_into('<IIQQQQQQ', data, 120, 2, 6, 256, 256, 0, len(dynamic) * 16, len(dynamic) * 16, 8)
    for index, pair in enumerate(dynamic):
        struct.pack_into('<qQ', data, 256 + index * 16, *pair)
    data[1024:1024 + len(strings)] = strings
    return data


class NativeAuditTests(unittest.TestCase):
    def test_accepts_expected_arm64_native_dependencies(self):
        result = audit_elf(elf(), 'libnode.so')
        self.assertEqual(result['machine'], 'AArch64')
        self.assertTrue(result['loadAlignment16KiB'])
        self.assertEqual(result['dependencies'], ['libc.so'])
        self.assertEqual(audit_elf(elf(('libnode.so', 'libc.so')), 'libcharliflix.so')['dependencies'], ['libc.so', 'libnode.so'])

    def test_rejects_wrong_architecture_and_small_page_alignment(self):
        for offset, layout, value in [(4, '<B', 1), (5, '<B', 2), (18, '<H', 62), (16, '<H', 2)]:
            with self.subTest(offset=offset):
                data = elf()
                struct.pack_into(layout, data, offset, value)
                with self.assertRaises(RuntimeError):
                    audit_elf(data, 'libnode.so')
        with self.assertRaises(RuntimeError):
            audit_elf(elf(alignment=4096), 'libnode.so')

    def test_rejects_truncated_and_out_of_bounds_binary_metadata(self):
        for data in [b'', bytes(elf()[:63]), bytes(elf()[:150])]:
            with self.subTest(size=len(data)), self.assertRaises(RuntimeError):
                audit_elf(data, 'libnode.so')
        for offset, layout, value in [(32, '<Q', 4096), (64 + 32, '<Q', 4096),
                                       (256 + 8, '<Q', 8192), (256 + 16 + 8, '<Q', 8192),
                                       (256 + 32 + 8, '<Q', 9 * 1024 * 1024)]:
            with self.subTest(offset=offset):
                data = elf()
                struct.pack_into(layout, data, offset, value)
                with self.assertRaises(RuntimeError):
                    audit_elf(data, 'libnode.so')

    def test_rejects_unshipped_duplicate_or_missing_dependencies(self):
        for needed in [('libevil.so',), ('libcharliflix.so',), ('libc.so', 'libc.so'), ()]:
            with self.subTest(needed=needed), self.assertRaises(RuntimeError):
                audit_elf(elf(needed), 'libnode.so')
        with self.assertRaises(RuntimeError):
            audit_elf(elf(), 'libcharliflix.so')
        with self.assertRaises(RuntimeError):
            audit_elf(elf(), 'unexpected.so')


if __name__ == '__main__':
    unittest.main()
