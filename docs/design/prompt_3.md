https://gemini.google.com/app/8db6a686b55de2ab
https://gemini.google.com/app/a926d14160655611

Chaingammon: Historical Eras Asset Specification Manual

This document serves as the master art direction and asset production manual for the 2D flat-lay graphics of the backgammon boards, checkers, and branding elements across six pivotal historical eras.

Technical Baseline & Universal Constraints

All assets must strictly adhere to these technical baselines to ensure perfect alignment, extraction, and clean gameplay rendering.

1. Board Asset Template (Strict 2D Flat-Lay)

Perspective: 90-degree orthogonal, completely top-down birds-eye view. Zero 3D tilt, zero camera skew, zero perspective or depth distortion.

Symmetry & Grid: The board must be perfectly symmetrical, split evenly down the exact horizontal center by a vertical center bar.

Points (Triangles): Exactly 24 long, sharp geometric triangles (points)—12 on the upper half pointing down, 12 on the lower half pointing up. Spaced perfectly and uniformly with identical pixel widths and heights.

Borders & Bevels: Borders must feature subtle interior-facing beveled edges and dynamic drop shadows to create a rich, realistic depth while keeping the playing surface 100% flat to the screen.

Branding Logo: Somewhere on the board (ideally centered on the vertical bar, or elegantly integrated into a corner/center medallion), the Chaingammon branding logo must be cleanly rendered.

Logo Specification: A crisp, circular medallion containing an hourglass silhouette made of a gold triangle on top ($\Delta$) and a white triangle on the bottom ($\nabla$).

Pristine State: The master background template must contain absolutely zero checkers, game pieces, dice, scoreboards, or UI overlay buttons.

2. Checker UI Sprites

Perspective: Perfectly vertical top-down orthogonal view (90-degree perspective).

Shape: Seamless, perfect circles with high-resolution, tactile surface textures.

Depth & Realism: Each piece must feature a fine, elegant outer bevel, realistic directional surface reflection/specular highlights, and a subtle, soft drop shadow offset to make it appear naturally elevated above the board.

Export State: Side-by-side checkers or individual isolated sprites on a solid, clean, #FFFFFF white background (or transparent PNG) for flawless alpha-channel extraction.

3. Google Drive Directory Structure

Files must be categorized and saved under /Education/AI/theme<number>/ where <number> corresponds to the Era Index (1 through 6).

theme<number>\_board_preview.png: The board with a stylized default checker setup (no tilt).

theme<number>\_board_clean.png: The pristine, completely empty board template (no checkers).

theme<number>\_checker_dark.png: The dark / "black" thematic checker asset.

theme<number>\_checker_light.png: The light / "white" thematic checker asset.

Era 1: Mesopotamia & Persia (The Cradle)

Character: Bozorgmehr the Wise

Aesthetic: Old-world luxury, desert sand, raw silk, polished lapis lazuli, agate, and turquoise.

Google Drive Folder: /Education/AI/theme1/

1. The Five Board Options

Option 1.1: The Royal Tombs of Ur (Reconstruction)

Materials: Weathered cedar wood, inlaid with small square mosaic tiles of mother-of-pearl, shell, and red limestone.

Points: Alternatively dark lapis lazuli blue and shell-white triangles, bordered by fine, dark bitumen-painted borders.

Center Bar: A thick band of lapis lazuli tiles separated by thin gold divider lines.

Chaingammon Logo: An ancient-style hammered gold medallion with the hourglass silhouette carved out of raw lapis lazuli and white shell.

Option 1.2: The Grand Vizier's Silk Tapestry

Materials: A background resembling a taut, tightly-woven Persian silk rug with rich emerald-green, gold, and crimson threading.

Points: Long, ornate floral-geometric triangles in deep turquoise and desert sand gold.

Center Bar: An embroidered gold brocade vertical band.

Chaingammon Logo: Embroidered directly into the center bar with shimmering gold thread on top and pearl-white thread on the bottom.

Option 1.3: The Burnt City Agate & Ebony

Materials: Deep, polished fossilized ebony wood with a soft, semi-gloss sheen.

Points: Translucent polished agate (banded orange-brown) and sky-blue turquoise stone points.

Center Bar: Inlaid strip of raw, polished bone.

Chaingammon Logo: Circular inlay of ebony wood with the hourglass carved in gold leaf and mammoth ivory.

Option 1.4: Mesopotamian Sandstone & Terracotta

Materials: Warm, fine-grained Mesopotamian sandstone with a desert-sand matte finish.

Points: Terracotta clay red and deep charcoal basalt stone triangles.

Center Bar: A shallow, carved channel in the sandstone showing raw granite beneath.

Chaingammon Logo: Carved directly into the sandstone center, inlaid with gold dust and white gypsum.

Option 1.5: Persian Palace Alabaster

Materials: Pure, translucent white alabaster stone with soft grey veins running horizontally.

Points: Rich turquoise and deep lapis-lazuli points with micro-gilded brass edges.

Center Bar: Solid brass vertical bar with dynamic light reflections.

Chaingammon Logo: Polished brass medallion with a dual-stone hourglass inlay (gold pyrite on top, white quartz on bottom).

2. Checkers Specification

Theme 1 Dark Checker (theme1_checker_dark.png): Polished, deep-blue Lapis Lazuli with concentric gold veins and a gold-rimmed bevel. High specular gloss.

Theme 1 Light Checker (theme1_checker_light.png): Highly polished, vibrant Persian Turquoise with soft white and dark brown webbing. Satin matte finish with clean edges.

Era 2: The Roman Evolution (Tabula)

Character: Senator Claudius Marcellus

Aesthetic: Imperial Rome, white marble, brass, Roman crimson, ivory, and polished bronze.

Google Drive Folder: /Education/AI/theme2/

1. The Five Board Options

Option 2.1: The Senator's Carrara Marble

Materials: High-grade, polished white Carrara marble with subtle grey marbling.

Points: Triangles of Imperial Crimson porphyry stone and rich golden sienna marble.

Center Bar: A raised, polished brass bar with sharp, clean shadows.

Chaingammon Logo: A cast Roman bronze coin medallion; the hourglass is represented by a gold-filled upper triangle and silver-plated lower triangle.

Option 2.2: The Chariot-Maker's Oak & Bronze

Materials: Weathered, rugged chariot oak wood with dark graining, showing slight battle wear.

Points: Hand-beaten bronze and dark, oxidized copper triangles.

Center Bar: A thick bronze band held in place by flat brass rivets.

Chaingammon Logo: A circular bronze seal featuring a relief carving of the hourglass medallion.

Option 2.3: Pompeian Red Stucco & Ivory

Materials: Rich, textured Pompeian red plaster finish, reminiscent of elite villa murals.

Points: Alternating smooth, polished elephant ivory (creamy white) and dark, polished basalt.

Center Bar: A vertical strip of painted black fresco design with golden key-patterns.

Chaingammon Logo: A micro-mosaic circular medallion using tiny tesserae of gold leaf and white marble.

Option 2.4: The Travertine Baths

Materials: Warm, porous travertine stone with a matte finish.

Points: Inlaid verdigris (patinated green copper) and raw terracotta tiles.

Center Bar: A vertical strip of polished Roman glass tiles.

Chaingammon Logo: A carved circular cartouche directly in the travertine, featuring gold leaf and white plaster inlays.

Option 2.5: The Imperial Crimson & Gold Leaf

Materials: Dark red stained mahogany base, buffed to a high-mirror gloss.

Points: Real gold leaf and dark charcoal-stained pearwood triangles.

Center Bar: A solid, gilded gold bar with fine geometric engravings.

Chaingammon Logo: A Roman Laurel Wreath medallion framing the gold and white hourglass.

2. Checkers Specification

Theme 2 Dark Checker (theme2_checker_dark.png): Carved, dark Roman Bronze with a raised rim and an embossed central eagle or legionary crest. Matte metallic finish.

Theme 2 Light Checker (theme2_checker_light.png): Creamy, hand-carved Roman Ivory with radial aged grain lines and a highly polished, smooth rounded edge.

Era 3: The East Asian Branches (Shuanglu & Sugoroku)

Character: Lady Meiling

Aesthetic: Tang & Song Dynasty court, black lacquer, hand-painted gold leaf, green jade, and white river stones.

Google Drive Folder: /Education/AI/theme3/

1. The Five Board Options

Option 3.1: The Emperor's Black Lacquer

Materials: Flawless, deep mirror-finish black lacquer with absolutely zero wood grain visible.

Points: Hand-painted gold leaf triangles with delicate, calligraphic brushstroke edges, alternating with silver leaf.

Center Bar: An intricate vertical strip of iridescent mother-of-pearl (Nacre) inlay.

Chaingammon Logo: A perfectly circular jade medallion with a gold-leafed top triangle and a white mother-of-pearl bottom triangle.

Option 3.2: Cinnabar & Jade Court

Materials: Deep-carved Chinese Cinnabar lacquer in brilliant, opaque imperial red.

Points: Translucent green nephrite jade and white mutton-fat jade triangles.

Center Bar: A vertical bamboo-styled divider carved from dark green jade.

Chaingammon Logo: An antiqued bronze coin-style medallion (like a Chinese cash coin with a round outer shape and the hourglass silhouette within).

Option 3.3: Imperial Court Plum Blossom

Materials: Light, polished paulownia wood (Kiri wood) with soft, vertical grain lines.

Points: Alternating hand-painted plum blossom pink and deep pine green lacquer triangles.

Center Bar: A dark ebony divider inlaid with small brass cherry blossoms.

Chaingammon Logo: A minimalist gold circle framing a gold and white lacquer hourglass.

Option 3.4: The Zen River Pebble

Materials: A soft, dark-grey river slate bed with a clean, smooth, water-worn texture.

Points: Strips of pure white quartz and dark volcanic basalt.

Center Bar: A vertical divider of dark, water-carved river stones.

Chaingammon Logo: Carved Zen-circle (Enso) framing a gold-sand and white-pebble hourglass.

Option 3.5: Silk Road Brocade

Materials: Rich, blue imperial silk brocade with golden dragon or cloud motifs.

Points: Triangles made of dark tortoiseshell and white nacre.

Center Bar: A vertical, hand-woven gold braid.

Chaingammon Logo: A circular embroidery piece, using gold-wrapped thread and pure white silk.

2. Checkers Specification

Theme 3 Dark Checker (theme3_checker_dark.png): Deep green Nephrite Jade with beautiful, cloudy natural inclusions and a high-sheen polish.

Theme 3 Light Checker (theme3_checker_light.png): Mutton-Fat White Jade (highly prized in the Tang Dynasty), featuring a soft, oily lustre and semi-translucent edges.

Era 4: The English Naming (Tables to Backgammon)

Character: Lord Charles Cavendish

Aesthetic: Restoration-era London, dark tavern oak, polished pewter, brass studs, green baize felt, and Tudor roses.

Google Drive Folder: /Education/AI/theme4/

1. The Five Board Options

Option 4.1: The King's Head Tavern Oak

Materials: Dark, hand-scraped English tavern oak with rich, deep-brown grain and a satin beeswax polish.

Points: Inlaid lighter English yew wood and dark, stained bog oak triangles.

Center Bar: A solid, heavy dark oak divider with fine brass inlaid joints.

Chaingammon Logo: Lord Cavendish's custom vector Tudor Rose medallion, cast in aged English pewter, with the central hourglass inlaid in gold and white enamel.

Option 4.2: Restoration Mahogany & Tortoiseshell

Materials: High-society, deep reddish-brown polished mahogany wood.

Points: Alternating honey-colored tortoiseshell and dark, polished ebony points.

Center Bar: A vertical divider of mirror-polished brass.

Chaingammon Logo: A circular gold-plated brass plate with engraving, containing the dual-colored hourglass.

Option 4.3: The Gentleman's Club Green Baize

Materials: Tightly stretched, fine green wool baize (gaming table felt).

Points: Inlaid leather points in deep burgundy red and rich tan brown, with gold-leaf tooling.

Center Bar: A dark walnut divider held with small, flat-head brass wood-screws.

Chaingammon Logo: A stamped leather medallion with a gold and white foil hourglass.

Option 4.4: The Sea Captain's Chart-Board

Materials: Aged, yellowed maritime parchment map showing stylized winds, laid over a teak wood board.

Points: Triangles styled as elongated compass-rose points in faded indigo blue and brick red ink.

Center Bar: A thick, polished brass navigation ruler.

Chaingammon Logo: A brass compass medallion with the gold/white hourglass centered over the dial.

Option 4.5: The Royal Stuart Marquetry

Materials: Highly intricate wood marquetry combining walnut, pearwood, and maple.

Points: Extremely detailed, wood-grained geometric triangles alternating in blond maple and dark walnut.

Center Bar: A vertical strip of checkerboard wood inlay (sycamore and ebony).

Chaingammon Logo: An inlaid circular wood medallion of light boxwood and dark rosewood.

2. Checkers Specification

Theme 4 Dark Checker (theme4_checker_dark.png): Dark pewter alloy with an intricate Tudor Rose pattern embossed on the surface, aged dark-grey patina in the crevices.

Theme 4 Light Checker (theme4_checker_light.png): Polished, spun English brass, catching bright specular highlights, with concentric circular scoring rings.

Era 5: The 1920s Modernization (The High-Roller)

Character: "Ace" Montgomery

Aesthetic: Art Deco Manhattan, smoky gaming clubs, polished walnut, Bakelite, chrome, cognac leather, and sharp pinstripes.

Google Drive Folder: /Education/AI/theme5/

1. The Five Board Options

Option 5.1: The Club Room Walnut & Bakelite

Materials: High-gloss, dark-stained walnut root wood with stunning swirl grains.

Points: Solid, opaque Bakelite points—alternating cream-yellow and butterscotch-orange.

Center Bar: A vertical strip of chrome-plated steel.

Chaingammon Logo: A sleek, geometric Art Deco chrome medallion; the hourglass features a gold-plated top and white enamel bottom.

Option 5.2: Smoked Glass & Mirror-Steel

Materials: Translucent smoked-grey glass over a brushed-steel background.

Points: Deep, frosted black glass and crisp, mirror-polished silver triangles.

Center Bar: A clean, vertical bar of frosted glass with sub-surface LED-style amber backlighting.

Chaingammon Logo: An etched glass circular emblem with gold-fill and white-enamel hourglass details.

Option 5.3: The Speakeasy Cognac Leather

Materials: Rich, textured cognac-brown leather with double-stitched perimeter seams.

Points: Inlaid cream leather and dark chocolate-brown leather triangles.

Center Bar: A solid mahogany wood divider with small chrome rivets.

Chaingammon Logo: Embossed gold-foil leather stamp containing the circular branding logo.

Option 5.4: Tuxedo Black & Mother-of-Pearl

Materials: Piano-key high-gloss black lacquer.

Points: Highly reflective, shimmering white Mother-of-Pearl and sharp, brushed chrome triangles.

Center Bar: A vertical stripe of white mother-of-pearl.

Chaingammon Logo: A circular, silver-rimmed medallion with an inlaid pearl and gold-leaf hourglass.

Option 5.5: Zebrano Modernist

Materials: Striking Zebrano exotic wood with vertical dark and light-brown zebra striping.

Points: Matte-finished cream and charcoal-grey composite resin triangles.

Center Bar: A thick vertical bar of brushed brass.

Chaingammon Logo: A brushed brass medallion, geometrically milled to display the gold/white hourglass.

2. Checkers Specification

Theme 5 Dark Checker (theme5_checker_dark.png): Polished, opaque black Bakelite with a deep red swirl pattern, featuring a sharp, geometric Art Deco stepped-rim design.

Theme 5 Light Checker (theme5_checker_light.png): Cream-colored Bakelite with a subtle yellow marbleized effect, polished to a high, vintage gloss.

Era 6: The Neural Net Disciple (The AI Era)

Character: Elena "Zero" Vance

Aesthetic: Matte black aluminum, glowing status LEDs, minimalist dark-mode terminal screens, and neon light-pipes.

Google Drive Folder: /Education/AI/theme6/

1. The Five Board Options

Option 6.1: The Carbon & Cyan Grid

Materials: Ultra-modern, weave-textured black carbon fiber with a semi-matte finish.

Points: Laser-sharp, glowing cyan blue ($490\text{ nm}$ wavelength) and deep purple light-pipe triangles.

Center Bar: A sleek vertical bar of matte-black anodized titanium with integrated white glowing status line.

Chaingammon Logo: A circular, holographic projected medallion; the hourglass glows in gold-neon ($590\text{ nm}$) on top and crisp white-neon on the bottom.

Option 6.2: Obsidian Terminal (Dark Mode)

Materials: Deep, scratch-resistant obsidian glass with a dark grey terminal grid background ($12\%$ opacity grid lines).

Points: Vector-sharp, minimalist triangles in amber-gold and bright terminal-green.

Center Bar: A gap in the glass showing an illuminated green circuit-board bus line beneath.

Chaingammon Logo: A circular, green-gold digital-ring medallion with a micro-LED illuminated hourglass.

Option 6.3: Anodized Titanium & Laser-Etch

Materials: Bead-blasted, space-grey anodized aluminum.

Points: Precision laser-etched, cross-hatched triangles in dark charcoal and silver-white.

Center Bar: A vertical groove of polished chrome.

Chaingammon Logo: A laser-engraved circular seal with a polished gold-plated and silver-plated hourglass insert.

Option 6.4: Liquid Metal Hologram

Materials: A dynamic, fluid liquid-mercury background with a subtle chrome-like ripple texture.

Points: Sharp, geometric voids in the mercury showing high-intensity white light and deep cobalt blue light from beneath.

Center Bar: A thick, solid block of matte-black polycarbonate.

Chaingammon Logo: A physical matte-black badge with a glowing liquid-gold and liquid-white hourglass.

Option 6.5: Polycarbonate Engine Room

Materials: Frosted, semi-translucent smoke-polycarbonate showing faint, high-tech cooling micro-channels underneath.

Points: Solid, bright UV-reactive orange and cobalt-blue acrylic triangles.

Center Bar: A glowing white acrylic lightbar dividing the courts.

Chaingammon Logo: A clean, vector-style flat graphic medallion printed directly onto the polycarbonate.

2. Checkers Specification

Theme 6 Dark Checker (theme6_checker_dark.png): Matte-black anodized aluminum with an integrated, glowing neon-cyan ring running along its outer bevelled groove.

Theme 6 Light Checker (theme6_checker_light.png): Translucent, frosted acrylic with a bright white LED core casting a soft, diffuse glow onto the board surface below.

Production Cheat-Sheet & Matrix

Use this quick-reference matrix for generating the assets in any graphic suite or AI engine:

Theme #

Era / Aesthetic

Dark Checker Material

Light Checker Material

Core Board Material

Theme 1

Mesopotamia & Persia

Lapis Lazuli & Gold

Persian Turquoise

Cedarwood / Silk Tapestry / Alabaster

Theme 2

Roman Evolution

Dark Embossed Bronze

Hand-Carved Ivory

Carrara Marble / Chariot Oak / Travertine

Theme 3

East Asian Branches

Deep Green Nephrite Jade

Mutton-Fat White Jade

Black Lacquer / Red Cinnabar / Paulownia

Theme 4

English Naming

Aged Patina Pewter

Spun Concentric Brass

Tavern Oak / Mahogany / Green Baize

Theme 5

1920s Modernization

Red-Swirl Black Bakelite

Marbled Cream Bakelite

Walnut Root / Smoked Glass / Cognac Leather

Theme 6

Neural Net / AI

Carbon Fiber & Cyan LED

Frosted White LED Acrylic

Matte Polycarbonate / Anodized Titanium

Design Checklist before Exporting:

[ ] Check that the board has absolutely zero camera skew, angle, or perspective distortion (it must look flat, like a texture map).

[ ] Ensure the 24 points are perfectly uniform in dimension and spacing across the left and right quadrants.

[ ] Verify that the Chaingammon logo is clearly legible, retaining the circular medallion shape with the gold-over-white hourglass.

[ ] Ensure no checkers are rendered on the clean boards (\_board_clean.png).

[ ] Export individual checker assets with seamless, soft contact shadows to guarantee high-fidelity layering during live web-game play.
