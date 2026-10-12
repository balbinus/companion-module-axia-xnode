# companion-module-axia-xnode

[Bitfocus Companion](https://bitfocus.io/companion) module for Axia **xNode** (legacy, LWRP 1.2) and **xNode2** (LWRP 1.4) audio nodes. It talks LWRP over TCP port 93 to monitor and control the mixer, destinations, sources, level alerts and GPIO. It is read-only until write permissions are enabled in the module configuration.

User documentation: [companion/HELP.md](./companion/HELP.md). Licence: [MIT](./LICENSE).

## Development

Requires Node (see `engines` in `package.json`) and Yarn 4. The manifest targets the node26 runtime (`engines` is `^26`), but local development, tests and builds work on Node 22; Yarn may print an engines warning there, which can be ignored.

```sh
yarn            # install dependencies
yarn build      # compile to dist/
yarn dev        # compile in watch mode
yarn lint       # eslint
yarn format     # prettier -w .
yarn test       # vitest run (unit and fake-device tests)
yarn test:watch
yarn package    # build + companion-module-build (module package)
```

Companion API: `@companion-module/base` 2.x (typed `InstanceBase`).

## Layout

```
src/
  main.ts          Companion glue: config, status, wiring of controller events to definitions; the source discovery outlives
                   device restarts (config saves) and restarts only when its own settings change
  config.ts        config fields and ModuleConfig
  actions.ts       action definitions -> device/operations
  feedbacks.ts     feedback definitions (evaluation in model/derived)
  variables.ts     variable definitions and values
  presets.ts       presets generated from the detected model
  choices.ts       dropdown choices and crosspoint pickers
  lwrp/            protocol: line parser/formatter, Livewire addresses, dB <-> tenths, partyline decoder (cmsg2, partyline)
  model/           state (single merge path for every line), I/O map, derived values, Livewire source directory (directory)
  device/          TCP connection, controller (sync, subscriptions, heartbeat), operations (validated writes), HTTP meters,
                   partyline-listener (receive-only multicast socket), discovery (listener + decoder + directory)
companion/         manifest.json and HELP.md
test/              vitest tests and fixtures
```

Everything outside `main.ts` and the definition builders is independent of `InstanceBase`, so the controller and operations can run from a plain Node script or a test.

## Tests

- **Unit tests** (`test/lwrp`, `test/model`, ...): parser, Livewire helpers, units, I/O map, state, choices. Fixtures in `test/fixtures` are recorded node answers.
- **Fake xNode server** (`test/helpers/mock-xnode.ts`): in-process TCP server emulating both dialects (legacy without echo and without `BEGIN`/`END` around `MIX`; xNode2 with out-of-order answers, dropped lines and errors). Used by the connection, controller and operations tests.
- **Live tests** (`test/live/*.test.ts`): skipped unless an environment variable names a real node.

  | Variable               | Node         | Access                                   |
  | ---------------------- | ------------ | ---------------------------------------- |
  | `XNODE_LEGACY_HOST`    | legacy xNode | read and write; every change is restored |
  | `XNODE_LEGACY_RO_HOST` | legacy xNode | strictly read-only                       |
  | `XNODE2_HOST`          | xNode2       | read and write; every change is restored |

  ```sh
  XNODE_LEGACY_HOST=<ip> XNODE_LEGACY_RO_HOST=<ip> XNODE2_HOST=<ip> yarn test
  ```

  Live tests must never write `SET`, `IP`, `MIXCFG`, input source or phantom power, and never query `INP` on legacy nodes. Use test devices, not production nodes.

- **Source discovery live test** (`test/live/partyline.test.ts`): skipped unless `PARTYLINE_LIVE=1`. It only listens to the Livewire partyline (multicast `239.192.255.3:4001`); nothing is sent. Keepalives come every 10 to 20 seconds and full adverts about every 150 seconds, so it can take up to about 4 minutes. The network must have at least one device that advertises a source.

  | Variable          | Meaning                                                                            |
  | ----------------- | ---------------------------------------------------------------------------------- |
  | `PARTYLINE_LIVE`  | `1` to run the test                                                                |
  | `PARTYLINE_IFACE` | optional: IP of the local network interface to join the group on (default: system) |

  ```sh
  PARTYLINE_LIVE=1 PARTYLINE_IFACE=<ip> yarn vitest run test/live/partyline.test.ts
  ```

Tests encode the intended behaviour; a known bug is kept as `it.fails(...)` with a `// BUG:` comment.
