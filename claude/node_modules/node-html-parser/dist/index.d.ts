import CommentNode from './nodes/comment';
import HTMLElement, { type Options } from './nodes/html';
import Node from './nodes/node';
import TextNode from './nodes/text';
import NodeType from './nodes/type';
import baseParse from './parse';
import valid from './valid';
export type { Options } from './nodes/html';
export { parse, HTMLElement, CommentNode, valid, Node, TextNode, NodeType };
declare function parse(data: string, options?: Partial<Options>): HTMLElement;
export default parse;
declare namespace parse {
    export { baseParse as parse };
    export { HTMLElement };
    export { CommentNode };
    export { valid };
    export { Node };
    export { TextNode };
    export { NodeType };
}
