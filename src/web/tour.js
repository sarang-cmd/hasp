// A guided tour that dims the page and waits for you to actually do things.
//
// The brief asks for a walkthrough where the product gets dimmed and highlighted,
// the steps point at real controls, and the user types a real key rather than
// watching an animation. That shape has three parts:
//
//   spotlight  a full page dim with a transparent hole over the target element
//   card       an anchor card with the instruction and the button that advances
//   gate       a predicate the step waits on before it will advance
//
// The gate is the part that makes it a tutorial instead of a slideshow. A step
// either watches for a condition (the item exists, the search field has text) or it
// does not advance at all.
//
// Demo values are typed one character at a time so the field is visibly being
// filled rather than silently appearing. Nothing here touches the network: every
// value it types is invented and is labelled as such in the card.

import { icons } from "./icons.js";

/** Position of an element, clamped into the viewport, for painting the hole. */
function boxOf(el, pad = 8) {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: Math.max(r.left - pad, 0),
    y: Math.max(r.top - pad, 0),
    w: Math.min(r.width + pad * 2, vw),
    h: Math.min(r.height + pad * 2, vh),
  };
}

/** Does the step's condition hold right now? */
function gateOpen(step) {
  try {
    return step.done ? step.done() : true;
  } catch {
    return false;
  }
}

/**
 * Type a value into an input, one character at a time.
 *
 * It sets the value through the native setter and dispatches an input event, so a
 * component that listens for input (the search field, the editor fields) reacts
 * exactly as it would to a person. Assigning .value directly would not.
 */
export async function typeInto(input, text, { perChar = 34, writable = true } = {}) {
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  const areaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  const apply = input.tagName === "TEXTAREA" ? areaSetter : setter;

  input.focus();
  for (let i = 1; i <= text.length; i++) {
    if (writable) {
      if (apply) apply.call(input, text.slice(0, i));
      else input.value = text.slice(0, i);
    }
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, perChar));
  }
  input.dispatchEvent(new window.Event("change", { bubbles: true }));
  return true;
}

export class Tour {
  /**
   * @param {object[]} steps  { target: () => Element | null, title, body, action?, done?, advance? }
   * @param {object} options  { onFinish, onSkip }
   */
  constructor(steps, options = {}) {
    this.steps = steps.filter(Boolean);
    this.options = options;
    this.index = 0;
    this.layer = null;
    this.raf = null;
    this.poll = null;
    this.done = false;
    this.waiting = false;
  }

  get step() {
    return this.steps[this.index];
  }

  /** Build the DOM once, then move the hole and the card on every step. */
  start() {
    if (this.layer || this.steps.length === 0) return this;
    const layer = document.createElement("div");
    layer.className = "tour";
    layer.setAttribute("role", "dialog");
    layer.setAttribute("aria-modal", "true");
    layer.setAttribute("aria-label", "Product walkthrough");
    layer.innerHTML = `
      <div class="tour-hole" part="hole"></div>
      <div class="tour-card" role="document">
        <div class="tour-meta"><span class="tour-step"></span><span class="tour-demo">Sample data</span></div>
        <h2 class="tour-title"></h2>
        <p class="tour-body"></p>
        <div class="tour-acts">
          <button class="btn btn--quiet btn--small" type="button" data-tour-skip>Skip tour</button>
          <button class="btn btn--primary btn--small" type="button" data-tour-next></button>
        </div>
      </div>`;
    // The scroll lock belongs to the layer, not to the caller: anything that opens
    // the tour needs the page frozen behind it, and a constructor that leaves that
    // to its caller will eventually be called by someone who forgets.
    document.body.classList.add("is-touring");
    document.body.appendChild(layer);
    this.layer = layer;

    layer.addEventListener("click", (e) => {
      if (e.target.closest("[data-tour-skip]")) return this.finish("skipped");
      if (e.target.closest("[data-tour-next]")) return this.next();
    });

    // Escape leaves the tour. It never leaves the vault locked or half-edited: the
    // tour only adds and searches, and both are reversible.
    this.onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.finish("skipped");
      }
    };
    document.addEventListener("keydown", this.onKey);

    this.paint();
    return this;
  }

  /** Move the hole and rewrite the card for the current step. */
  paint() {
    if (!this.layer) return;
    const step = this.step;
    if (!step) return this.finish("complete");

    const target = step.target?.();
    const hole = this.layer.querySelector(".tour-hole");
    const card = this.layer.querySelector(".tour-card");

    if (target) {
      const box = boxOf(target);
      Object.assign(hole.style, {
        left: `${box.x}px`,
        top: `${box.y}px`,
        width: `${box.w}px`,
        height: `${box.h}px`,
        opacity: "1",
      });
      // Put the card below the hole when there is room, above it otherwise.
      const gap = 16;
      const cardH = 210;
      const below = box.y + box.h + gap;
      const placeBelow = below + cardH < window.innerHeight;
      card.style.left = `${Math.max(16, Math.min(box.x, window.innerWidth - 400))}px`;
      card.style.top = placeBelow ? `${below}px` : `${Math.max(16, box.y - gap - cardH)}px`;
      // Scroll the target into view before measuring next time.
      if (target.scrollIntoView) target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    } else {
      hole.style.opacity = "0";
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
    }

    this.layer.querySelector(".tour-step").textContent = `Step ${this.index + 1} of ${this.steps.length}`;
    this.layer.querySelector(".tour-title").textContent = step.title;
    this.layer.querySelector(".tour-body").textContent = step.body;
    const next = this.layer.querySelector("[data-tour-next]");
    next.textContent = step.action || (this.index === this.steps.length - 1 ? "Done" : "Next");

    // A step with a gate cannot be advanced by the button: the condition is the
    // point. The button stays enabled but tells the truth about why it will not
    // move yet.
    this.watch();
  }

  /** Poll the step's gate. Cheap, and it stops as soon as the step changes. */
  watch() {
    clearInterval(this.poll);
    const step = this.step;
    if (!step?.done) return;

    const check = () => {
      if (this.step !== step) return clearInterval(this.poll);
      const open = gateOpen(step);
      const next = this.layer?.querySelector("[data-tour-next]");
      if (next) {
        next.textContent = open ? step.action || "Next" : step.waiting || "Waiting for you";
        next.classList.toggle("is-gated", !open);
      }
      if (open && step.autoAdvance !== false) {
        clearInterval(this.poll);
        setTimeout(() => this.next(), step.advance ?? 700);
      }
    };
    check();
    this.poll = setInterval(check, 250);
  }

  next() {
    const step = this.step;
    if (!step) return this.finish("complete");
    // A gated step refuses to move until its condition holds. This is what stops
    // the tour from becoming a slideshow that promises interaction it never asks for.
    if (step.done && !gateOpen(step)) {
      const next = this.layer.querySelector("[data-tour-next]");
      next.classList.remove("is-gated");
      void next.offsetWidth; // restart the shake
      next.classList.add("is-gated");
      return;
    }
    // Steps that must run something before moving on (open the editor, type a value)
    if (step.advance) {
      const result = step.advance();
      if (result === false) return;
    }
    this.index += 1;
    if (this.index >= this.steps.length) return this.finish("complete");
    if (this.layer.querySelector(".tour-card")) this.layer.querySelector(".tour-card").style.transform = "";
    this.paint();
  }

  finish(reason = "complete") {
    if (this.done) return;
    this.done = true;
    clearInterval(this.poll);
    document.removeEventListener("keydown", this.onKey);
    cancelAnimationFrame(this.raf);
    this.layer?.remove();
    this.layer = null;
    document.body.classList.remove("is-touring");
    // Remember the outcome so the walkthrough is offered once, not every visit.
    try {
      localStorage.setItem("hasp.tour", reason);
    } catch {
      // Storage blocked: it will offer itself again. That is the honest failure,
      // and better than pretending it saved.
    }
    this.options.onFinish?.(reason);
  }
}

/** The tour definition, kept next to the engine so the copy and the gates agree. */
export function buildTour(app) {
  const $ = (sel) => document.querySelector(sel);
  return new Tour(
    [
      {
        target: () => $("#app .rail-nav"),
        title: "This is your vault",
        body: "Keys, backup codes and one-time codes in one list. Everything in this tour is sample data. Nothing you make here is real.",
        action: "Start",
      },
      {
        target: () => $("#app .topbar"),
        title: "Search is local",
        body: "Search runs against a blind index on this machine. Type a word below to see it work.",
        done: () => Boolean($("[data-search]")?.value?.trim()),
        waiting: "Search to continue",
        advance: async () => {
          const input = $("[data-search]");
          if (input) await typeInto(input, "stripe", { perChar: 26 });
        },
      },
      {
        target: () => $("[data-add]") || $(".topbar"),
        title: "Add a key",
        body: "Open the editor. You will type a demo key into it, so you can see how a real one is stored.",
        done: () => Boolean($(".modal")),
        waiting: "Open the editor",
        action: "Open editor",
        advance: () => {
          $("[data-add]")?.click();
        },
        autoAdvance: true,
      },
      {
        target: () => $(".modal #f-value") || $(".modal"),
        title: "Type the demo key",
        body: "Watch the field fill. This value is invented, and the vault treats it exactly like a real one.",
        done: () => {
          const v = $(".modal #f-value")?.value || "";
          return v.length > 18;
        },
        waiting: "Type the key",
        action: "Type it for me",
        advance: async () => {
          const input = $(".modal #f-value");
          if (!input) return false;
          const name = $(".modal #f-name");
          if (name && !name.value) await typeInto(name, "Demo Groq key", { perChar: 22 });
          await typeInto(input, "gsk_demo_0000_not_a_real_key", { perChar: 30 });
        },
        autoAdvance: false,
      },
      {
        target: () => $(".modal-foot"),
        title: "Save it",
        body: "The item is encrypted before it reaches the disk. Save and you will see it in the list.",
        done: () => !$(".modal"),
        waiting: "Save the item",
        action: "Save",
        advance: () => {
          $(".modal form button[type=submit]")?.click();
        },
      },
      {
        target: () => $(".inspector") || $("#app .main"),
        title: "Reveal and copy",
        body: "Secrets stay masked until you ask. Copy puts the value on the clipboard and clears it after 30 seconds.",
        action: "Got it",
      },
      {
        target: () => $(".rail-foot") || $(".rail"),
        title: "That is the tour",
        body: "Clear the search, then read the vault. The sample password is printed on the unlock screen because this build ships invented data.",
        action: "Finish",
        advance: () => {
          const input = $("[data-search]");
          if (input) {
            input.value = "";
            input.dispatchEvent(new window.Event("input", { bubbles: true }));
          }
        },
      },
    ],
    { onFinish: (reason) => app?.onTourFinish?.(reason) }
  );
}
