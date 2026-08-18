// Builds the web-image-search query for a story slide with no feed
// photo. Pulls out capitalized-word runs (player and club names) from
// the full headline rather than trusting the headline's own "key" flag
// -- writeSlide() marks whatever part it judged "the news" as key,
// which is sometimes a transfer fee or other non-name detail rather
// than strictly a name (seen in production: "Man City eye £120m
// Fernandez move" marked "Man City" and "£120m" as key, but not
// "Fernandez" -- the search query ended up as "Man City £120m",
// missing the one player the story was actually about, and returning a
// barely-related photo). A capitalized-word run naturally excludes
// numbers, currency figures, and percentages (none of them start with
// an uppercase letter) while still catching a name embedded in a
// non-key part like "Fernandez move", since headline connector words
// are consistently written lowercase by writeSlide()'s own prompt.
//
// \p{Lu}/\p{L} (Unicode letter categories, not plain A-Z) so accented
// names -- Mbappé, Atlético, Müller -- aren't truncated at the accent.
const NAME_WORD = /\p{Lu}[\p{L}'-]*/gu;

export function searchQuery(slide) {
  const headline = (slide.headline_parts || []).map((p) => p.text).join(' ');
  return (headline.match(NAME_WORD) || []).join(' ');
}
