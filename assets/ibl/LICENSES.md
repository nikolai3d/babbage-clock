# Environment map licences

Every HDR panorama in `assets/ibl/` comes from [Poly Haven](https://polyhaven.com)
and is released under **[CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)**
(public domain dedication — no attribution required, none of it viral). Poly Haven
is credited here anyway because it is the decent thing to do and because a future
bead needs to know where a file came from before replacing it.

Each preset repeats its own provenance in the `source` block of its
`preset.json`, which is the authoritative record; this file is the summary.

| Preset               | File                                          | Title                                   | Author(s)              | Licence | Source                                                       |
| -------------------- | --------------------------------------------- | --------------------------------------- | ---------------------- | ------- | ------------------------------------------------------------ |
| `day`                | `kloofendal_overcast_puresky_1k.hdr`          | Kloofendal Overcast (Pure Sky)          | Greg Zaal              | CC0-1.0 | https://polyhaven.com/a/kloofendal_overcast_puresky          |
| `sunny-day`          | `kloofendal_48d_partly_cloudy_puresky_1k.hdr` | Kloofendal 48d Partly Cloudy (Pure Sky) | Greg Zaal, Jarod Guest | CC0-1.0 | https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky |
| `night`              | `dikhololo_night_1k.hdr`                      | Dikhololo Night                         | Greg Zaal              | CC0-1.0 | https://polyhaven.com/a/dikhololo_night                      |
| `steampunk-workshop` | `fireplace_1k.hdr`                            | Fireplace                               | Greg Zaal              | CC0-1.0 | https://polyhaven.com/a/fireplace                            |
| `busy-street`        | `hansaplatz_1k.hdr`                           | Hansaplatz                              | Greg Zaal              | CC0-1.0 | https://polyhaven.com/a/hansaplatz                           |

All five are the **1k Radiance (`.hdr`) variant**, between 1.1 MB and 1.7 MB
each. That is the smallest tier Poly Haven publishes that still holds up as a
reflection source on brass, and it keeps every preset inside the 2-3 MB budget.
Nothing here is loaded until a mood asks for it — see `docs/lighting.md`.
