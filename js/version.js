/**
 * Single source of truth for the deployed version.
 *
 * The site is hand-deployed static files with no build step, so the version lives here
 * and is stamped into every footer at runtime. One string to bump, and it cannot drift
 * between the four pages the way four copies of the markup would.
 *
 * Bump APP_VERSION and BUILD_DATE together in the same commit that ships the change.
 */

export const APP_VERSION = 'v2.3.1';
export const BUILD_DATE = '2026-08-08';

/**
 * Appended rather than written into the markup so the four footers stay free of anything
 * that has to be kept in sync by hand.
 */
function stampVersion() {
  const foot = document.querySelector('footer.foot');
  if (!foot || foot.querySelector('.foot-version')) return;
  const p = document.createElement('p');
  p.className = 'foot-version';
  const tag = document.createElement('span');
  tag.className = 'foot-version-tag';
  tag.textContent = APP_VERSION;
  p.append(tag, ` · built ${BUILD_DATE}`);
  foot.appendChild(p);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', stampVersion);
} else {
  stampVersion();
}
