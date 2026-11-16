# KiCad libraries from other publishers

Symbol and footprint libraries that Crossprobe offers next to KiCad's own:
parts that are not in KiCad's standard libraries and that a designer would
otherwise fetch by hand.

Each folder is one library, named by its KiCad nickname:

```
<Nickname>/
  SOURCE.md                 where it comes from, which revision, what was changed
  LICENSE                   the publisher's licence, as shipped
  <Nickname>.kicad_sym      the symbols
  <Nickname>.pretty/        the footprints
```

`THIRD_PARTY_LIBRARIES` in `packages/kicad-model/src/third-party-libraries.ts`
lists them with their publisher and licence. That list is what the app and
the design builder use to credit a library wherever one of its parts ends up
in a design.

`apps/web/server/bundled-libs.ts` serves them to the app through the dev
server, beside the KiCad libraries installed on the computer.

These files keep their own licences. They are not covered by the licence of
the rest of this repository.
