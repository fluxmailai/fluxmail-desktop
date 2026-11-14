import { describe, expect, it } from "vitest";
import {
  cssString,
  findCssImageUrls,
  findCssUrls,
  hasRemoteCssImage,
  parseSrcset,
  rewriteCssImages,
  serializeSrcset,
  stripCssComments,
} from "../src/renderer/email/css-urls";

describe("CSS image scanning", () => {
  it("finds url() the way the CSS tokenizer does", () => {
    const urls = (css: string) => findCssUrls(css).map(({ url }) => url);

    expect(urls("a{background:url( https://a.example/x.png )}")).toEqual([
      "https://a.example/x.png",
    ]);
    expect(urls('url("\\68ttps://a.example/\\"q\\".png")')).toEqual(['https://a.example/"q".png']);
    expect(urls("u\\72 l(\\68 ttps://a.example/x.png)")).toEqual(["https://a.example/x.png"]);
    expect(urls('url("https://a.example/x.png" crossorigin(anonymous))')).toEqual([
      "https://a.example/x.png",
    ]);
    expect(urls("url(https://a.example/x.png")).toEqual(["https://a.example/x.png"]);
    // These aren't url() to a browser: a bad URL, other identifiers, and text in comments or strings.
    expect(urls("url(https://a.example/x y)")).toEqual([]);
    expect(urls("url(https://a.example/(x))")).toEqual([]);
    expect(urls("myurl(https://a.example/x.png) 3url(x) #url(y) @url(z)")).toEqual([]);
    expect(urls('/* url(https://a.example/x.png) */ "url(https://a.example/y.png)"')).toEqual([]);
    expect(urls('"url(\n url(https://a.example/z.png)')).toEqual(["https://a.example/z.png"]);
  });

  it("finds image-set() strings and keeps going past unbalanced text", () => {
    expect(
      findCssImageUrls(
        `/* image-set( */ "image-set(" a { background: -webkit-image-set("https://a.example/1.png" 1x, url(https://a.example/2.png) 2x) } b { background: image-set("https://a.example/3.png"`,
      ),
    ).toEqual(["https://a.example/1.png", "https://a.example/2.png", "https://a.example/3.png"]);
  });

  it("rewrites url() and image-set() candidates", () => {
    const css = `a { background: url(https://a.example/1.png); mask: image-set("https://a.example/2.png" 1x, url(https://a.example/3.png) 2x, linear-gradient(red, blue) 3x); }`;

    expect(
      rewriteCssImages(css, {
        url: (url) => `url(${cssString(`relay:${url}`)})`,
        imageSetString: (url) => cssString(`relay:${url}`),
      }),
    ).toBe(
      `a { background: url("relay:https://a.example/1.png"); mask: image-set("relay:https://a.example/2.png" 1x, url("relay:https://a.example/3.png") 2x, linear-gradient(red, blue) 3x); }`,
    );
    expect(
      rewriteCssImages(css, {
        removeImageSetCandidate: (url) => url.endsWith("2.png") || url.endsWith("3.png"),
        url: () => "none",
      }),
    ).toBe(`a { background: none; mask: image-set(linear-gradient(red, blue) 3x); }`);
    expect(
      rewriteCssImages(`image-set("x" 1x, "y" 2x`, { removeImageSetCandidate: () => true }),
    ).toBe("none");
    expect(
      rewriteCssImages(`image-set("x" 1x, image-set("y" 1x, "z" 2x) 2x`, {
        removeImageSetCandidate: (url) => url === "y",
      }),
    ).toBe(`image-set("x" 1x, image-set("z" 2x) 2x`);
  });

  it("rewrites deeply nested CSS without recursion", () => {
    const css = 'url("a" '.repeat(50_000);

    expect(rewriteCssImages(css, { url: () => "none" })).toBe("none");
  });

  it("quotes CSS strings", () => {
    expect(cssString('a"b\\c\nd')).toBe('"a\\"b\\\\c\\a d"');
  });

  it("strips closed comments", () => {
    expect(stripCssComments("a/* x */b/* y")).toBe("ab/* y");
  });
});

describe("remote CSS image detection", () => {
  it("counts remote images in image properties only", () => {
    expect(hasRemoteCssImage(["background: url(https://a.example/x.png)"])).toBe(true);
    expect(hasRemoteCssImage(["b\\61 ckground: url(\\68ttps://a.example/x.png)"])).toBe(true);
    expect(hasRemoteCssImage(['a { content: image-set("https://a.example/x.png" 1x) }'])).toBe(
      true,
    );
    expect(hasRemoteCssImage(["@font-face { src: url(https://a.example/x.woff2) }"])).toBe(false);
    expect(hasRemoteCssImage(["background: url(data:image/png;base64,AAAA)"])).toBe(false);
    expect(hasRemoteCssImage(["/* background: url(https://a.example/x.png) */"])).toBe(false);
  });

  it("follows custom properties across style sheets and attributes", () => {
    expect(
      hasRemoteCssImage([
        ":root { --b: url(https://a.example/x.png); --a: var(--b) }",
        "background-image: var( --a )",
      ]),
    ).toBe(true);
    expect(
      hasRemoteCssImage([":root { --a: url(https://a.example/x.png) }", "color: var(--a)"]),
    ).toBe(false);
  });
});

describe("srcset parsing", () => {
  it("follows the HTML srcset algorithm", () => {
    expect(
      parseSrcset(" a.png 1x,b.png, data:image/png;base64,AA,BB 2x , c.png (x, y) 3x,,"),
    ).toEqual([
      { url: "a.png", descriptor: "1x" },
      { url: "b.png", descriptor: "" },
      { url: "data:image/png;base64,AA,BB", descriptor: "2x" },
      { url: "c.png", descriptor: "(x, y) 3x" },
    ]);
    expect(serializeSrcset(parseSrcset("a.png 1x,b.png"))).toBe("a.png 1x, b.png");
  });
});
