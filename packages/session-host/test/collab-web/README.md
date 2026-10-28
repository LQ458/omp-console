# Vendored test support from omp collab-web

`link.ts`, `client.ts`, `codec.ts`, `socket.ts` and `local-relay.ts` are copied from
[oh-my-pi](https://github.com/can1357/oh-my-pi) `packages/collab-web` (MIT,
Copyright Mario Zechner, Can Bölük, Stencil Labs, Inc.; see `/LICENSE`). The
package is not published to npm, and the tests use these files to act as a
collab guest and run a local relay. Only `local-relay.ts` changed: its import
of `link.ts` points at this folder.
