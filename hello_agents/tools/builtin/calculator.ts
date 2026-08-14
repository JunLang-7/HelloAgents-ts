import { z } from 'zod';

import { ToolErrorCode } from '../errors.js';
import { ToolResponse } from '../response.js';
import { Tool } from '../tool.js';

function numberText(value: number): string {
  return String(value);
}
type Token = { type: 'number' | 'name' | 'operator' | 'left' | 'right' | 'comma'; value: string };
const constants: Record<string, number> = { pi: Math.PI, e: Math.E };
function pythonRound(...values: number[]): number {
  if (values.length < 1 || values.length > 2) throw new Error('round 需要一或两个参数');
  const [value, digits = 0] = values;
  if (value === undefined || !Number.isInteger(digits) || !Number.isFinite(value)) {
    throw new Error('round 参数无效');
  }
  const scale = 10 ** digits;
  const scaled = value * scale;
  const lower = Math.floor(scaled);
  const fraction = scaled - lower;
  const epsilon = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  const rounded =
    Math.abs(fraction - 0.5) <= epsilon
      ? lower % 2 === 0
        ? lower
        : lower + 1
      : Math.round(scaled);
  return rounded / scale;
}
const functions: Record<string, (...values: number[]) => number> = {
  abs: Math.abs,
  round: pythonRound,
  max: Math.max,
  min: Math.min,
  sum: (...values) => values.reduce((sum, value) => sum + value, 0),
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log,
  exp: Math.exp
};
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    const space = /^\s+/.exec(rest);
    if (space) {
      index += space[0].length;
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number) {
      tokens.push({ type: 'number', value: number[0] });
      index += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) {
      tokens.push({ type: 'name', value: name[0] });
      index += name[0].length;
      continue;
    }
    const operator = rest.startsWith('**') ? '**' : rest[0];
    if (operator !== undefined && (operator === '**' || '+-*/^'.includes(operator))) {
      tokens.push({ type: 'operator', value: operator });
      index += operator.length;
      continue;
    }
    if (operator === '(') {
      tokens.push({ type: 'left', value: operator });
      index += 1;
      continue;
    }
    if (operator === ')') {
      tokens.push({ type: 'right', value: operator });
      index += 1;
      continue;
    }
    if (operator === ',') {
      tokens.push({ type: 'comma', value: operator });
      index += 1;
      continue;
    }
    throw new SyntaxError(`不支持的字符: ${JSON.stringify(operator)}`);
  }
  return tokens;
}
function evaluate(expression: string): number {
  const tokens = tokenize(expression);
  let index = 0;
  const peek = () => tokens[index];
  const consume = () => tokens[index++];
  const primary = (): number => {
    const token = consume();
    if (!token) throw new SyntaxError('表达式不完整');
    if (token.type === 'number') return Number(token.value);
    if (token.type === 'left') {
      const value = add();
      const close = consume();
      if (close?.type !== 'right') throw new SyntaxError('缺少右括号');
      return value;
    }
    if (token.type === 'name') {
      if (peek()?.type === 'left') {
        consume();
        const args: number[] = [];
        if (peek()?.type !== 'right') {
          args.push(add());
          while (peek()?.type === 'comma') {
            consume();
            args.push(add());
          }
        }
        if (consume()?.type !== 'right') throw new SyntaxError('缺少右括号');
        const fn = functions[token.value];
        if (!fn) throw new Error(`不支持的函数: ${token.value}`);
        return fn(...args);
      }
      if (token.value in constants) return constants[token.value] ?? 0;
      throw new Error(`未定义的变量: ${token.value}`);
    }
    throw new SyntaxError(`不支持的表达式: ${token.value}`);
  };
  const power = (): number => {
    const value = primary();
    if (peek()?.type === 'operator' && peek()?.value === '**') {
      consume();
      return value ** factor();
    }
    return value;
  };
  const factor = (): number => {
    if (peek()?.type === 'operator' && peek()?.value === '-') {
      consume();
      return -factor();
    }
    return power();
  };
  const multiply = (): number => {
    let value = factor();
    while (peek()?.type === 'operator' && ['*', '/'].includes(peek()?.value ?? '')) {
      const operator = consume()?.value;
      if (operator === undefined) throw new SyntaxError('表达式不完整');
      const right = factor();
      value = operator === '*' ? value * right : value / right;
    }
    return value;
  };
  const add = (): number => {
    let value = multiply();
    while (peek()?.type === 'operator' && ['+', '-', '^'].includes(peek()?.value ?? '')) {
      const operator = consume()?.value;
      if (operator === undefined) throw new SyntaxError('表达式不完整');
      const right = multiply();
      value = operator === '+' ? value + right : operator === '-' ? value - right : value ^ right;
    }
    return value;
  };
  const result = add();
  if (index !== tokens.length) throw new SyntaxError('表达式包含多余内容');
  return result;
}
/** Safely evaluates a whitelisted subset of Python-compatible arithmetic expressions. */
export class CalculatorTool extends Tool<typeof CalculatorTool.inputSchema> {
  static readonly inputSchema = z
    .object({ input: z.string().optional(), expression: z.string().optional() })
    .strict();
  public constructor() {
    super({
      name: 'python_calculator',
      description: '执行数学计算。支持基本运算、数学函数等。例如：2+3*4, sqrt(16), sin(pi/2)等。',
      inputSchema: CalculatorTool.inputSchema
    });
  }
  protected run(input: z.output<typeof CalculatorTool.inputSchema>): ToolResponse {
    const expression = input.input || input.expression || '';
    if (!expression) return ToolResponse.error(ToolErrorCode.INVALID_PARAM, '计算表达式不能为空');
    try {
      const result = evaluate(expression);
      const resultStr = numberText(result);
      return ToolResponse.success(`计算结果: ${resultStr}`, {
        expression,
        result,
        result_str: resultStr,
        result_type: 'number'
      });
    } catch (error) {
      const syntax = error instanceof SyntaxError;
      return ToolResponse.error(
        syntax ? ToolErrorCode.INVALID_FORMAT : ToolErrorCode.EXECUTION_ERROR,
        `${syntax ? '表达式语法错误' : '计算失败'}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { expression }
      );
    }
  }
}
/** Convenience helper that evaluates one expression through `CalculatorTool`. */
export const calculate = async (expression: string) =>
  new CalculatorTool().execute({ input: expression });
