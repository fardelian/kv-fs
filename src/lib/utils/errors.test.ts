import { describe, it, expect } from 'bun:test';
import {
    KvError,
    KvError_Init_Recursion,
    KvError_BD_Overflow,
    KvError_BD_NotFound,
    KvError_INode_NameOverflow,
    KvError_INode_KindMismatch,
    KvError_Enc_Key,
    KvError_FS_Exists,
    KvError_FS_NotFound,
    KvError_FS_NotEmpty,
    KvError_FS_FormatVersion,
} from './errors';

describe('KvError', () => {
    it('sets name from new.target so subclass instances report their own name', () => {
        const err = new KvError_FS_NotFound('missing');

        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(KvError);
        expect(err).toBeInstanceOf(KvError_FS_NotFound);
        expect(err.name).toBe('KvError_FS_NotFound');
        expect(err.message).toBe('missing');
    });

    it('can also be instantiated directly when a generic error is wanted', () => {
        const err = new KvError('generic');

        expect(err.name).toBe('KvError');
        expect(err.message).toBe('generic');
    });

    it('keeps each empty subclass distinct so callers can branch on type', () => {
        const errors: KvError[] = [
            new KvError_BD_NotFound('a'),
            new KvError_INode_NameOverflow('b'),
            new KvError_Enc_Key('c'),
            new KvError_FS_Exists('d'),
            new KvError_FS_NotEmpty('e'),
        ];
        const names = errors.map((e) => e.name);
        expect(new Set(names).size).toBe(errors.length);
    });

    it('builds custom messages from constructor arguments', () => {
        expect(new KvError_Init_Recursion().message).toMatch(/cannot be decorated/);
        expect(new KvError_BD_Overflow(99, 32).message).toBe('Data size "99" bytes exceeds block size "32" bytes.');
        expect(new KvError_FS_FormatVersion(7, 4).message).toContain('"7"');
    });

    it('exposes inode-kind-mismatch metadata fields', () => {
        const err = new KvError_INode_KindMismatch(7, 1, 0);

        expect(err).toBeInstanceOf(KvError);
        expect(err.name).toBe('KvError_INode_KindMismatch');
        expect(err.blockId).toBe(7);
        expect(err.expectedKind).toBe(1);
        expect(err.storedKind).toBe(0);
        expect(err.message).toBe('Inode at block "7" has stored kind 0, expected 1.');
    });
});
