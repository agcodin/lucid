/**
 * Maps between a contenteditable's text content and the text nodes it lives in.
 *
 * Built in one pass and reused for every offset lookup in a repaint, for the
 * same reason the web editor does it: resolving thousands of issue offsets by
 * rescanning the subtree each time is quadratic, and quadratic is what makes a
 * checker feel slow in a long document.
 */
export interface TextIndex {
  text: string;
  nodes: Text[];
  /** Absolute offset at which each node's text begins. */
  starts: number[];
}

const BLOCK_DISPLAY = /^(block|flow-root|list-item|table|table-cell|flex|grid)$/;

export function buildTextIndex(host: HTMLElement): TextIndex {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Skip anything not rendered: the offsets have to line up with what the
      // user can actually see and select.
      if (parent.closest('[hidden],[aria-hidden="true"],script,style,template')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let previousBlock: Element | undefined;

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const block = blockAncestor(textNode, host);

    // A new block element starts a new paragraph, which is what the engine
    // segments on — so each visual paragraph becomes its own cache unit.
    if (previousBlock !== undefined && block !== previousBlock && text.length > 0) {
      text += '\n\n';
    }
    previousBlock = block;

    starts.push(text.length);
    nodes.push(textNode);
    text += textNode.data;
  }

  return { text, nodes, starts };
}

function blockAncestor(node: Text, host: HTMLElement): Element {
  let element = node.parentElement;
  while (element && element !== host) {
    if (BLOCK_DISPLAY.test(getComputedStyle(element).display)) return element;
    element = element.parentElement;
  }
  return host;
}

/** Resolve an absolute offset to a text node and an offset inside it. */
export function pointAt(index: TextIndex, offset: number): { node: Text; offset: number } | undefined {
  const { nodes, starts } = index;
  if (nodes.length === 0) return undefined;

  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }

  const node = nodes[lo]!;
  const within = offset - starts[lo]!;
  // An offset inside an inserted paragraph separator has no node of its own;
  // clamp it to the end of the node before it.
  return { node, offset: within < 0 ? 0 : Math.min(within, node.data.length) };
}

export function rangeFor(index: TextIndex, start: number, end: number): Range | undefined {
  const from = pointAt(index, start);
  const to = pointAt(index, end);
  if (!from || !to) return undefined;
  const range = document.createRange();
  try {
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
  } catch {
    return undefined;
  }
  return range;
}
