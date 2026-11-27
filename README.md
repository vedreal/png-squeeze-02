# png-squeeze-02

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/vedreal/png-squeeze-02/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/vedreal/png-squeeze-02/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Squeeze screenshots into the smallest PNG — a make.fun bounty entry. A pure
TypeScript, Node-built-ins-only lossless PNG encoder: for each 1280×720 RGBA
screenshot it tries every lossless form (palette in count / luminance / RGB
order, grey / grey+alpha, RGB / RGBA, plus a tRNS-key form when one
transparent value can stand in for an alpha channel) and every per-row PNG
filter strategy (fixed filters, minimum-sum, fewest-distinct-pairs, and true
brute force weighed by zlib level 4 against the 32 KiB before each row).
Candidates are screened at zlib level 6; the best two per form are
re-compressed at level 9, memLevel 6, with the default and filtered
strategies. Smallest whole PNG wins. Fully deterministic — two runs write
identical bytes.

## Run

```sh
node main.ts
```

Reads `/input/<id>/image.png` (or `$MAKEFUN_INPUT_DIR`) and writes
`/output/<id>/image.png` (or `$MAKEFUN_OUTPUT_DIR`) for all 8 instances in
one run, within the 60 s wall budget.

## Benchmark

See [BENCHMARK.md](BENCHMARK.md): practice-set score **710,525** vs the house
baseline fixed-paeth 1.0.0's **420,399**, pixel-exact on all 8 instances,
~34 s for the set.
