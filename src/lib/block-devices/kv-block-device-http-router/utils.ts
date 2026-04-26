import { z } from 'zod';
import { KvBatchOp } from '../helpers/kv-block-device';

// ---- Schemas ----

/** Block IDs come from URL params (strings) so we coerce. */
export const blockIdShape = z.coerce.number().int().nonnegative();

/** Byte offsets / ranges inside a block. Same shape as block IDs at this layer. */
const byteOffsetShape = z.coerce.number().int().nonnegative();

/**
 * Hex string → `Uint8Array` transform. `hex` is whatever made it past
 * the JSON parser, so the schema also rejects anything that isn't a
 * valid hex pair sequence (Node's `Buffer.from(_, 'hex')` truncates on
 * the first invalid byte — we re-encode and compare to catch that).
 */
const hexBytesSchema = z.string().transform((hex, ctx) => {
    if (hex.length % 2 !== 0) {
        ctx.addIssue({ code: 'custom', message: 'Hex string must have even length.' });
        return z.NEVER;
    }
    const buf = Buffer.from(hex, 'hex');
    if (buf.length * 2 !== hex.length) {
        ctx.addIssue({ code: 'custom', message: 'Hex string contains invalid characters.' });
        return z.NEVER;
    }
    return new Uint8Array(buf);
});

/**
 * Wire batch ops, parsed straight into `KvBatchOp` (hex `data` becomes
 * `Uint8Array` via `hexBytesSchema`). The discriminator on `op` lets
 * zod give a precise error when a variant is missing required fields.
 */
const batchOpSchema: z.ZodType<KvBatchOp> = z.discriminatedUnion('op', [
    z.object({ op: z.literal('alloc') }),
    z.object({ op: z.literal('read'), blockId: z.number().int().nonnegative() }),
    z.object({ op: z.literal('free'), blockId: z.number().int().nonnegative() }),
    z.object({ op: z.literal('write'), blockId: z.number().int().nonnegative(), data: hexBytesSchema }),
    z.object({
        op: z.literal('partial-read'),
        blockId: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
    }),
    z.object({
        op: z.literal('partial-write'),
        blockId: z.number().int().nonnegative(),
        offset: z.number().int().nonnegative(),
        data: hexBytesSchema,
    }),
]);

export const batchBodySchema = z.object({ ops: z.array(batchOpSchema) });

/** `?confirm=yes` gate for the device-wide `DELETE /blocks`. Anything else is rejected. */
export const formatConfirmSchema = z.object({ confirm: z.literal('yes') });

/** Both `start` and `end` required; `end >= start`. */
const partialRangeSchema = z.object({
    start: byteOffsetShape,
    end: byteOffsetShape,
}).refine((v) => v.end >= v.start);

const partialOffsetSchema = z.object({ offset: byteOffsetShape });

/**
 * Express's `raw()` middleware delivers a `Buffer`; tests / other
 * middleware may deliver a plain `Uint8Array`. Buffer extends Uint8Array
 * but we re-view it so the returned bytes don't carry Buffer's prototype
 * methods — keeps the call site dealing in plain Uint8Array.
 */
export const bodyBytesSchema = z.union([
    z.instanceof(Buffer).transform((b) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)),
    z.instanceof(Uint8Array),
]);

// ---- Helpers ----

/**
 * `?start=X&end=Y` lifted out of `req.query`. Returns `null` for the
 * "no range" case (full-block read), the parsed range when both parse,
 * or `'invalid'` on any other shape — including the mixed-presence case
 * (only one of the two), which the schema rejects because both fields
 * are required.
 */
export function parseRangeQuery(query: unknown): { start: number; end: number } | null | 'invalid' {
    const q = query as { start?: unknown; end?: unknown };
    if (q.start === undefined && q.end === undefined) return null;
    const result = partialRangeSchema.safeParse(q);
    return result.success ? { start: result.data.start, end: result.data.end } : 'invalid';
}

/** `?offset=X` lifted out of `req.query`. Same null/value/'invalid' shape. */
export function parseOffsetQuery(query: unknown): number | null | 'invalid' {
    const q = query as { offset?: unknown };
    if (q.offset === undefined) return null;
    const result = partialOffsetSchema.safeParse(q);
    return result.success ? result.data.offset : 'invalid';
}

export function hexEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}

/**
 * First issue's message — the batch schema bails on first failure
 * anyway. `err.issues` always has at least one entry when `safeParse`
 * returned `success: false`, so no fallback is needed.
 */
export function zodMessage(err: z.ZodError): string {
    return err.issues[0].message;
}
