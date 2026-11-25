import type HTMLElement from './nodes/html';
import type Node from './nodes/node';
/**
 * Minimal Adapter interface matching css-select's Adapter<Node, ElementNode>.
 * Defined locally because css-select v5 does not export its types publicly.
 */
interface Adapter {
    isTag: (node: Node) => node is HTMLElement;
    existsOne: (test: (elem: HTMLElement) => boolean, elems: Node[]) => boolean;
    getAttributeValue: (elem: HTMLElement, name: string) => string | undefined;
    getChildren: (node: Node) => Node[];
    getName: (elem: HTMLElement) => string;
    getParent: (node: HTMLElement) => Node | null;
    getSiblings: (node: Node) => Node[];
    getText: (node: Node) => string;
    hasAttrib: (elem: HTMLElement, name: string) => boolean;
    removeSubsets: (nodes: Node[]) => Node[];
    findAll: (test: (elem: HTMLElement) => boolean, nodes: Node[]) => HTMLElement[];
    findOne: (test: (elem: HTMLElement) => boolean, elems: Node[]) => HTMLElement | null;
}
declare const matcher: Adapter;
export default matcher;
