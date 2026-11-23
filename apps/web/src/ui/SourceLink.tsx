/**
 * The top bar's link to the editor's source: GitHub's mark (third_party/octicons), at the right
 * end. An extension can leave it out (Extension.hidesSourceLink).
 */
import githubMark from "../../../../third_party/octicons/mark-github-16.svg";

/** Where the editor's source is. */
export const SOURCE_URL = "https://github.com/Crossprobe-AI/crossprobe-core";

export function SourceLink() {
  return (
    <a className="source-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer" title="Source on GitHub" aria-label="Source on GitHub">
      {/* The mark as a mask, so it takes the top bar's text colour. */}
      <span className="source-mark" aria-hidden="true" style={{ maskImage: `url("${githubMark}")`, WebkitMaskImage: `url("${githubMark}")` }} />
    </a>
  );
}
