# Reactions

Add reaction sounds as MP3 files using this structure:

- `base/` → shared sounds for all languages and age levels
- `<language>/base/` → language-specific sounds suitable for all ages
- `<language>/adult/` → language-specific adult sounds

Current language folders:

- `tr/`
- `en/`
- `es/`

## File Naming

Filenames are automatically converted to display labels:

- File: `ya-sabir.mp3`
- Display: **Ya Sabir**

Rules:

- Use hyphens (`-`) between words
- `.mp3` extension is removed
- Each word starts with an uppercase letter in the UI

## Suggestions

- File size: < 500 KB
- Duration: 1-5 seconds
- Format: MP3
