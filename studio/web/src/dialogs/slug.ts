// slug.ts: a version id from its title. The server's rule (studio/db.js's ID_RE) is a lowercase letter or digit, then
// up to 40 more letters, digits or hyphens; slug() always gives an id that passes it, or '' when the title has no
// letters or digits to make one from.

export const VERSION_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const MAX_LENGTH = 41;

export const isValidVersionId = (id: string) => VERSION_ID.test(id);

export function slug(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // NFKD split the accents off as combining marks: drop them ("Café" is "cafe")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/, '');
}
