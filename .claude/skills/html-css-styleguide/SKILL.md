---
name: html-css-styleguide
description: >-
  Apply Google's HTML/CSS Style Guide when writing, editing, or reviewing HTML
  documents and templates and CSS, Sass, or GSS style sheets, even when no
  style guide is mentioned. Covers HTTPS resources, indentation, lowercase,
  UTF-8, TODO comments, doctype, validity, semantic elements, alt text,
  separation of concerns, entity references, optional tags, type and id
  attributes, markup formatting and quoting, class naming, selectors,
  shorthand properties, units and colors, !important, and CSS formatting.
  For JSX, TSX, and framework templates, apply only the rules that carry
  over, such as semantics, alt text, and attribute quoting, without fighting
  the framework's syntax or the project's formatter; use JavaScript or
  TypeScript guidance for the surrounding code.
license: CC-BY-3.0
---

# Google HTML/CSS style guide

Apply the [Google HTML/CSS Style
Guide](https://google.github.io/styleguide/htmlcssguide.html) to HTML and CSS
that is being written or changed. It governs raw, working source files: HTML
documents and templates, CSS, and Sass or GSS style sheets. Output produced by
minifiers, compilers, or obfuscators is exempt as long as overall code quality
holds. The guide sets no column limit for HTML and names no formatter; where a
project has one configured, let it settle layout.

Explicit user instructions, the project's configuration (formatter, linters,
browser support targets, framework contracts), and established local
conventions take precedence; the guide itself ends by asking authors to match
the style of the surrounding code. Do not mass-reformat files, rename classes
or ids that scripts, tests, or other sites depend on, or change tooling merely
to apply the guide. Keep style-only cleanup separate from behavior changes,
and explain material deviations.

## General rules

-   Load embedded resources (images, media, style sheets, scripts, and CSS
    `@import` targets) over `https:` unless a file is not available over
    HTTPS. Avoid protocol-relative `//` URLs as well as plain `http:`.
-   Indent by 2 spaces. Never indent with tabs, alone or mixed with spaces.
-   Write everything in lowercase: element and attribute names, attribute
    values (other than `text`/CDATA values), selectors, property names, and
    property values (other than strings). For example, `#3a7bd5`, not
    `#3A7BD5`.
-   Remove trailing whitespace; it only complicates diffs.
-   Save files as UTF-8 without a byte order mark. Declare the encoding in
    HTML documents and templates with `<meta charset="utf-8">`, but not in
    style sheets, which are assumed to be UTF-8.
-   Comment code where it helps: what it covers, what it is for, and why this
    approach was chosen. The guide treats comments as optional, since how
    much documentation is realistic depends on the project.
-   Mark action items with the keyword `TODO` alone, not other markers such
    as `@@`, and put the action after a colon: `TODO: action item`.

## HTML

-   Begin every document with `<!doctype html>` to get no-quirks mode. No
    doctype means quirks mode, and other doctypes can mean limited-quirks
    mode; both deviate from documented behavior and tend to cause subtle
    failures in code written for no-quirks mode.
-   Write valid HTML where possible. The only exception the guide allows is a
    file-size performance goal that cannot otherwise be met. It suggests the
    W3C validator for checking.
-   Use each element for its purpose, for accessibility, reuse, and
    efficiency: headings for headings, `p` for paragraphs, `a` for links, and
    so on. Do not build a link or button out of a scripted `div`.
-   Provide alternatives for multimedia: meaningful `alt` text for images, and
    transcripts and captions for audio and video where available. Use an
    empty `alt=""` when the text would only repeat nearby content, or for a
    purely decorative image that cannot simply move into CSS.
-   Keep structure, presentation, and behavior apart, with minimal contact
    between them. Markup holds only structural HTML; presentational elements,
    attributes, and inline styles move to style sheets, and behavior moves to
    scripts. Keep the number of linked style sheets and scripts minimal.
-   Do not use entity references such as `&mdash;` or `&#x263a;`; type the
    character in UTF-8. Exceptions: characters that HTML treats specially,
    such as `<` and `&`, and control or invisible characters, such as
    no-break spaces.
-   Optional: omit optional tags, as defined by the HTML specification's
    tag-omission rules, to save bytes and ease scanning. A project adopting
    this should omit all of them rather than a selection; the guide notes
    that such a change may need a grace period.
-   Omit `type` on style sheets and scripts, since HTML defaults to
    `text/css` and `text/javascript`. Keep it for resources that are not CSS
    or JavaScript, and use `type="module"` whenever a `script` element loads
    a JavaScript module.
-   Avoid unnecessary `id` attributes: style through `class`, and hook
    scripts onto `data-*` attributes. When an `id` is truly required, as for an
    ARIA reference, put a hyphen in the value (`order-summary`, not
    `orderSummary` or `summary`). Browsers expose ids as named properties of
    `window`, and a hyphenated id cannot be used as a global variable.

## HTML formatting

-   Put each block, list, or table element on a line of its own, whatever
    its CSS `display` value, and indent it when its parent is also a block,
    list, or table element.
-   If whitespace between list items causes trouble, all `li` elements may
    share one line; the guide asks linters to warn rather than fail on this.
-   Wrapping long lines is optional; wrap only when it clearly helps
    readability. Indent continuation lines so that wrapped attributes stand
    apart from child elements, and wrap the same way across the project,
    preferably enforced by a formatter. Accepted layouts include one
    attribute per line (closing `>` on its own line or after the last
    attribute), a single 4-space continuation line, and attributes aligned
    under the first one.
-   Quote attribute values with double quotes, not single quotes.

## CSS

-   Write valid CSS where possible. Exceptions are validator bugs and
    necessary proprietary syntax; the guide suggests the W3C CSS validator.
-   Name classes after the purpose of the element, which is clearest and
    least likely to change, or use a generic name for a helper with no
    distinct meaning. Avoid presentational names (naming a color or a layout
    effect) and cryptic ones.
-   Keep class names brief, but never so brief that what the class is for
    becomes unclear.
-   Separate words in class names with hyphens (`.order-total`). Never run
    words together or join them with underscores or other characters.
-   Optional: in large projects, and for code embedded in other projects or
    sites, prefix class names with a short, unique namespace and a hyphen,
    such as `.acme-`.
-   Do not qualify class selectors with element names (`ul.menu`) unless
    necessary, as with helper classes.
-   Avoid ID selectors and prefer class selectors everywhere; ids must be
    unique per page, which is hard to guarantee across many components and
    authors.
-   Use shorthand properties (`font`, `padding`, `border-top`) wherever
    possible, even when only one value is set explicitly. When applying this,
    remember that a shorthand resets every longhand it omits; check that
    nothing set elsewhere in the cascade is lost.
-   Omit units after `0` unless required, as in the basis part of `flex`.
-   Always write the leading zero for values between -1 and 1: `0.5em`, not
    `.5em`.
-   Use 3-character hexadecimal colors where possible: `#fff`, not `#ffffff`.
-   Avoid `!important`, which breaks the natural cascade; override with
    selector specificity instead.
-   Avoid user-agent detection and CSS hacks; treat them as a last resort
    after other approaches fail.

## CSS formatting

-   Optional: keep one declaration order throughout a project. Without
    tooling that enforces an order, alphabetize declarations. Ignore vendor
    prefixes when sorting, but keep several prefixed forms of one property
    sorted among themselves (`-moz-` before `-webkit-`).
-   Indent all block content: declarations, and rules nested in other rules
    such as `@media`.
-   Finish each declaration with a semicolon, the last one in a block too.
-   Put one space after a property's colon and none before it.
-   Follow the final selector with a single space and the `{`, keeping the
    brace on that selector's line.
-   Give each selector and each declaration its own line.
-   Separate rules with one blank line.
-   Use single quotes, not double, in attribute selectors and property
    values. Do not quote `url()` values. Exception: `@charset` requires
    double quotes.
-   Optional: group sections of a style sheet under section comments,
    separated by blank lines.

This original example follows the rules above:

```css
/* Order summary */

.order-summary,
.order-empty {
  font: 0.875em/1.4 'Source Sans', sans-serif;
  margin: 0;
  padding: 0.5em 1em;
}

@media print {
  .order-summary {
    color: #333;
  }
}
```

## Templates, JSX, and TSX (application guidance)

The guide's own examples include template syntax, so its rules apply to HTML
templates as written. For JSX, TSX, and component templates, carry over only
what fits the framework:

-   Semantic elements, alt text, and other accessible alternatives.
-   Double quotes for string attribute values (`className="card"`); values in
    braces are expressions, not attribute strings.
-   Literal UTF-8 characters instead of entity references, keeping escapes
    for characters with syntactic meaning in the template language and for
    invisible characters.
-   `TODO:` comments in the template language's own comment syntax.
-   Classes over ids, and hyphenated values for ids that are required.
-   The CSS rules, for style sheets the project writes by hand.

Leave the rest to the framework and the project's formatter. JSX must close
every element, so optional tags cannot be omitted. Attribute and component
names follow the framework's casing (React's `className` and `onClick`, or
capitalized component names), not the lowercase rule. A document shell or the
framework owns the doctype. Utility-first or CSS-in-JS styling is a project
decision about separating concerns; do not convert utility classes into
semantic class names to satisfy this guide.

## Check the change

-   Run the project's configured formatter, linters, and tests, including any
    accessibility or visual checks. Where the formatter's output differs from
    the guide (CSS string quotes, for example), keep the formatter's result
    rather than hand-editing against it.
-   When the project has no validator configured, the guide's own options are
    the W3C [HTML validator](https://validator.w3.org/nu/) and
    [CSS validator](https://jigsaw.w3.org/css-validator/). Do not add tooling
    solely for this skill.
-   Formatting and validation do not prove correct rendering or behavior;
    look at affected pages or components when markup or cascade order
    changes.
-   For a review-only request, report findings (location, rule, minimal fix)
    without editing files.

## Source and attribution

Adapted and condensed from the [Google HTML/CSS Style
Guide](https://google.github.io/styleguide/htmlcssguide.html), checked on
2026-11-03 at commit `ab89e73` of the `gh-pages` branch of
[google/styleguide](https://github.com/google/styleguide). This skill
condenses and reorganizes the guide and adds application guidance; it is not
an official Google publication, and its examples are original. Google's
guides are licensed under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/), and code samples
in that repository under the
[Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
