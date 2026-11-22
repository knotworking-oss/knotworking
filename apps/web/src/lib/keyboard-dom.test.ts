import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./keyboard";

const el = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host.firstElementChild as HTMLElement;
};

describe("isTypingTarget", () => {
  it("is true for text-entry elements", () => {
    expect(isTypingTarget(el("<input />"))).toBe(true);
    expect(isTypingTarget(el("<textarea></textarea>"))).toBe(true);
    expect(isTypingTarget(el("<select><option>a</option></select>"))).toBe(true);
  });

  it("is true for contenteditable regions", () => {
    const editable = el('<div contenteditable="true"></div>');
    // jsdom does not implement the isContentEditable getter, so provide it as browsers do.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTypingTarget(editable)).toBe(true);
  });

  it("is false for everything else", () => {
    expect(isTypingTarget(el("<button>x</button>"))).toBe(false);
    expect(isTypingTarget(el("<div></div>"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
  });

  it("is false for non-element targets", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(document)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
  });
});
