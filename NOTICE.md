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
