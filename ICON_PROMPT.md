# AgentScribe — iOS App Icon Generation Prompt

Use with: GPT-4o image generation, Sora image, or any high-fidelity diffusion model. Tested phrasing for ChatGPT image tool.

---

## PRIMARY PROMPT (paste directly into GPT)

Create a premium iOS app icon for **AgentScribe**, a developer tool that records browser workflows and transforms them into machine-readable agent instructions. Render at **1024 × 1024 pixels**, exactly square, full bleed — do NOT round the corners yourself (Apple's system rounds them at install time). The icon should look at home on the App Store next to Linear, Figma, Arc, Raycast, and Things 3 — premium, distinctly designed, instantly recognizable at 60 × 60 px on a home screen.

**Background**: A deep graphite-to-obsidian radial gradient, slightly darker in the corners than the center. Base color is a near-black charcoal (#0a0d11) lightening subtly toward (#1a1d22) at the upper-left to suggest a soft top-down light source. Overlay an extremely faint, etched isometric grid pattern at ~6% opacity — fine 1-pixel cyan-tinted lines running in two diagonals, evoking a TRON Legacy / Blade Runner 2049 digital-substrate texture. The grid should be barely perceptible at full size and invisible at small thumbnail size — it adds tactile depth, not visual noise.

**Hero glyph** (occupies the central ~65% of the canvas, with generous symmetrical breathing room on all sides): A stylized **quill pen nib** rendered in a clean, modern, sharp-edged geometric style — NOT skeuomorphic, NOT vintage feather. Think of it as the iconic dip-pen nib silhouette: a slender pointed triangle with a central slit running its length, slightly tapered at the tip, gently widening toward the back. The nib is angled at approximately 30 degrees from vertical, tip pointing toward the lower-right corner as if mid-stroke writing.

**The transformation**: The rear half of the nib (the wider end) **dissolves into circuit-board traces** — three to five glowing pathways that emerge from the body of the nib and flow upward and outward, terminating in small luminous node-dots. This is the visual metaphor: the scribe's quill becomes the agent's instruction set. The transition from solid nib to circuit traces should feel organic, not hard-edged — a gradient melt over roughly 20% of the nib's length.

**Materials and surface**:
- The solid nib body is rendered in brushed obsidian metal (#1a1d24 with subtle micro-scratches and a soft anisotropic highlight running along its length), edged with a thin 1-pixel phosphor-green bevel on the lit edge (the upper-left facing side).
- The slit down the nib's center glows with a soft phosphor-green inner light (#7DFFBA, 70% opacity, slight gaussian bloom).
- The nib tip itself is bright white-cyan (#cffaff), as if it's about to touch paper and emit light — a sharp pinpoint of luminance.
- The circuit traces emerging from the back are rendered in solid phosphor green (#7DFFBA) with a soft 2-pixel outer glow (bloom radius ~4px). Each trace is 2 pixels wide. The node-dots at trace endpoints are small filled circles (3-4px diameter) in a brighter green-white, also with bloom.

**The recording indicator** (subtle but present, a small storytelling detail): A single **tiny solid red dot** (#FF4565) at the very upper-right shoulder of the nib, approximately 12 pixels in diameter, with a soft outer glow halo at 60% opacity. This signifies "live recording" — the universal red-dot record signal. It should be readable but never dominant; it's a punctuation mark, not a focal point.

**Composition rules**:
- Centered, symmetrical breathing room — minimum 12% margin from any edge to the nearest meaningful element.
- The nib should occupy a strong diagonal axis from upper-left to lower-right.
- Visual weight balanced: the bright nib tip in the lower-right is balanced by the bloom from the circuit traces emerging in the upper-left.
- Strong silhouette readable at 60 × 60 pixels.

**Lighting**:
- Single soft top-down light source from the upper-left, ~30 degrees above the horizon.
- Subtle ambient occlusion in the recessed slit of the nib and around the base where circuit traces emerge.
- Faint atmospheric haze / dust mote particles (3-5 specks at ~15% opacity) floating in the background to add a sense of depth and "live capture."

**Style references**:
- Apple Human Interface Guidelines for iOS 18+ app icons
- Linear, Raycast, Arc, Things 3 — premium professional tool icons
- TRON Legacy / TRON Ares cinematography (phosphor glow on dark substrates)
- Blade Runner 2049 holographic interface design
- The luminous physicality of high-end product photography

**DO NOT include**:
- Any text, letterforms, monograms, wordmarks, or initials on the icon
- Generic AI clichés (no neural-network nodes, no brain shapes, no robot heads, no chat bubbles, no purple/pink "AI" gradients)
- Photographic feathers, ink splatters, paper textures, or vintage typewriter aesthetics
- Soft pastel palettes — this is a dark, technical, professional tool
- Cluttered background ornaments, stars, sparkles, or busy decorative elements
- More than two accent colors against the dark base (just phosphor green and a single red record dot)
- Drop shadows under the icon itself (Apple's system adds those at runtime)

**Output**: 1024 × 1024 PNG, lossless, full opacity (no transparency in the background), suitable for direct submission to the App Store icon slot or Chrome Web Store extension icon.

---

## ALTERNATIVE PROMPT A — minimalist / Apple-design-language

Same product (AgentScribe — a Chrome extension that captures browser workflows and exports them as agent-readable instructions). Same iOS 1024×1024 format. This version goes minimalist:

A single perfectly centered **abstract "scribe mark"** — a curved calligraphic stroke that begins as a solid obsidian quill-nib silhouette in the upper-left and gradually transitions into a phosphor-green digital-circuit pathway terminating in three node-dots in the lower-right. Background is a flat solid deep graphite (#0E1116) with no gradient, no texture. The stroke is the only element. Premium, minimal, instantly readable. Single red record dot at the start of the stroke, very small. No other ornament.

---

## ALTERNATIVE PROMPT B — bolder / "tool icon" feel

A square iOS app icon for AgentScribe, a Chrome extension developer tool. Centered hero: a **stylized capture-cursor reticle** — a diamond-shaped crosshair frame in phosphor green (#7DFFBA), 3px stroke, with subtle inner glow. Inside the reticle, suspended in the center: a small white-cyan **stylus / nib tip** as if being targeted for capture. The reticle has four corner-brackets in TRON-style L-shape glyphs at each corner of the icon canvas (well inset from edges). Background: deep graphite radial gradient. A tiny red record-dot sits in the upper-right corner outside the reticle.

This version reads more like a developer tool than the primary prompt — more "Postman / Insomnia / Hoppscotch" than "premium creative app." Use if the primary feels too soft.

---

## ALTERNATIVE PROMPT C — bolder / typographic anchor

A square 1024×1024 iOS icon. Background: deep graphite #0a0d11 with faint isometric grid texture. Centered hero: a single capital letter **"A"** rendered as if drawn by a digital plotter — the letter is constructed from glowing phosphor-green circuit-pathway segments (#7DFFBA) with small luminous node-dots at every junction and terminus. The crossbar of the A is a horizontal circuit trace; the two diagonal strokes are vertical traces with circuit-board step patterns. A small red record-dot is positioned at the apex of the A. Premium, distinctive, readable at any size. Phosphor-green only on a dark base — no other colors.

This version is wordmark-adjacent — only if you want the letter A to be the brand mark. The primary prompt is wordmark-free per Apple conventions.

---

## SIZE EXPORTS NEEDED FROM THE WINNER

Once you have the 1024×1024 hero render, you'll want to also produce or downscale to:

- **Chrome Web Store**: 128×128 (extension primary), 48×48 (extension list), 16×16 (browser toolbar)
- **iOS / macOS / iPadOS** (if shipped as an app): 1024×1024, 180×180, 167×167, 152×152, 120×120, 87×87, 80×80, 76×76, 60×60, 58×58, 40×40, 29×29
- **Web favicon**: 32×32 and 16×16 ICO, 180×180 apple-touch-icon
- **App Store / marketing**: 1024×1024 unrounded for App Store, plus a 512×512 PNG with the rounded squircle pre-baked for marketing splash images

Most modern icon-export tools (App Icon Generator, MakeAppIcon, Bakery) take the 1024×1024 master and produce the full set in one upload.

---

## ITERATION GUIDANCE

If GPT's first render isn't there:

- "Too bright / too cheerful" → add: "Substantially darker overall, near-black base, all luminance comes from the phosphor green elements only."
- "Looks generic AI" → add: "No neural-network imagery, no brain shapes, no glowing humanoid heads, no chat-bubble shapes. Reference Linear, Raycast, Postman, Things 3."
- "Nib looks too vintage / feathery" → add: "The nib must be sharp, geometric, modern — like a Pilot G2 pen tip rendered in technical CAD style, not a Victorian feather quill."
- "Circuit traces too cluttered" → add: "Maximum three traces emerging from the nib, clean and minimal, not a circuit-board jungle."
- "Red record dot too prominent" → add: "The red record dot is a tiny accent only — under 2% of the canvas area, not glowing aggressively, no bloom halo larger than the dot itself."
- "Background grid too visible" → add: "Reduce the grid pattern to nearly invisible — 3% opacity maximum, only perceptible on close inspection."

---

**Generated by [MAX] · 2026-05-20 · for AgentScribe v1.0.13 visual identity refresh**
