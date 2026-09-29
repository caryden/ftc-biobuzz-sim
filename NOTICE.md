# Notices

The MIT license in `LICENSE` covers the code, the documents, and the experiment data that the authors of this
repository wrote. It doesn't cover the following material, which belongs to others.

## Field and game element models

`public/field.glb` and `public/balls.gltf` are converted from the official BIOBUZZ field CAD that *FIRST* publishes on
its Playing Field Resources page. `cad/field-manifest.json` holds positions and part names that were read from the
same CAD. The designs belong to *FIRST* and its suppliers. They are included so that the simulator can draw the
official field, and they aren't relicensed here. The source STEP file isn't in the repository. If you are a rights
holder and want a file removed, open an issue.

## Trademarks

*FIRST*®, *FIRST*® Tech Challenge, and BIOBUZZ℠ are trademarks of For Inspiration and Recognition of Science and
Technology (*FIRST*). AndyMark, goBILDA, Limelight, Gopher, and ResisDent are trademarks of their owners. This project
isn't affiliated with, sponsored by, or endorsed by *FIRST* or by any of those companies.

## Rules and numbers

Point values, field dimensions, and rule numbers come from the BIOBUZZ Competition Manual and the Event Field Setup
Guide. Ball weights come from AndyMark's product page. The code comments and `README.md` cite each source.

## Software dependencies

The simulator uses Rapier (`@dimforge/rapier3d-compat`, Apache-2.0) and three.js (MIT). The model converters use
`occt-import-js` (LGPL-2.1), which runs only on a developer's machine and isn't part of the site. The pages load the
Barlow Condensed and IBM Plex typefaces from Google Fonts under the SIL Open Font License.

## Icons

The simulator's control bar inlines nine icons from Lucide (lucide.dev): rotate-ccw, skip-back, play, pause,
skip-forward, settings, circle-help, chevron-down, and x. Lucide is under the ISC license. circle-help, chevron-down,
and x come from Feather, under the MIT license. The notices follow.

```
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

```
The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
