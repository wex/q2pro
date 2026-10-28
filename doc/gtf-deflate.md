# GTF_DEFLATE stream compression

Branch: `feat/gtf-deflate`

## Scope

Request and consume a zlib-compressed GTV stream, cutting upstream bandwidth
for live spectating roughly in half on busy servers (the C gtv client reports
`total_in / total_out` ratios; per-frame MVD payloads compress well).

## Wire semantics (verified against src/server/mvd)

- The **client** advertises support by setting `GTF_DEFLATE` (0x1) in its own
  `GTC_HELLO` flags (`send_hello`, `src/server/mvd/client.c:1046`).
- The **server** grants it by echoing the flag in `GTS_HELLO`
  (`parse_hello`, `src/server/mvd.c:1536`) — servers built without zlib
  silently clear the bit, so requesting is always safe.
- After `GTS_HELLO`, **every inbound byte** — including the u16 message
  length headers — is one continuous zlib stream (`deflateInit` +
  `Z_DEFAULT_COMPRESSION`, flushed with `Z_SYNC_FLUSH` per tick,
  `Z_FINISH` on drop). Client→server traffic is never compressed.
- On `Z_STREAM_END` the remaining inbound bytes revert to plaintext
  (`inflate_more` → `z_act = false`, `src/server/mvd/client.c:1405`).

## Implementation

`MvdClient` gains a `deflate` option (default **true**):

- `sendHello` sets `GTF_DEFLATE` in the request flags.
- `handleHello` starts a `zlib.createInflate()` stream when the granted
  `GTS_HELLO` flags contain the bit.
- `onTcpData` routes chunks to the inflater while active; inflated output
  lands in the same `recvBuf` FIFO as before, so `pendingMsgLen` /
  `parseOneMessage` framing is untouched.
- Compressed bytes that share a TCP segment with the plaintext `GTS_HELLO`
  are handed to the inflater at activation time rather than parsed raw —
  matching the C client's separate `stream.recv` / `z_buf` FIFOs.
- Inflate `'end'` flips the remainder of the connection back to plaintext;
  `'error'` surfaces `{ code: 'INFLATE' }` on the `error` event and
  soft-closes (reconnect-eligible).
- `client.flags` exposes the negotiated flags, so consumers can check
  `flags & GTF_DEFLATE` to see whether compression is actually on.

No `app.ts` or API-surface changes — the feature is transparent to the
pipeline.

## Usage

```ts
const client = new MvdClient({ host, port });          // deflate on
const client = new MvdClient({ host, port, deflate: false }); // opt out
```
