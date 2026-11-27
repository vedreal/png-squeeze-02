# Benchmark — kit practice set (8 instances, i001–i008)

Run locally with the kit scorer (`program/scorer/score.ts`) on
`practice/input` vs `practice/reference`:

- **Practice-set score: 710,525** (house baseline fixed-paeth 1.0.0: 420,399)
- **Passed: 1, answered 8/8, pixel-exact on all 8 instances**
- **Runtime: ~34 s for the whole set of 8** (limit 60 s)
- **Determinism: two runs write byte-identical outputs** (verified with `diff -r`)

## Per-instance results

| instance | theme | bytes | scale bytes | points (of 1000) |
|----------|-------|------:|------------:|-----------------:|
| i001 | flat  |  12,440 |  13,547 | 721.126 |
| i002 | rich  |  51,206 |  55,063 | 713.360 |
| i003 | alpha | 105,136 | 107,892 | 683.696 |
| i004 | grey  | 105,353 | 110,521 | 697.838 |
| i005 | flat  |  16,461 |  18,669 | 745.501 |
| i006 | rich  | 177,572 | 185,295 | 694.452 |
| i007 | alpha |  60,503 |  64,285 | 705.884 |
| i008 | grey  |  24,568 |  26,807 | 722.340 |

Every instance beats the scale compressor's size (the 666.67-point mark), so
the entry beats the house baseline by a wide margin on the practice set.
