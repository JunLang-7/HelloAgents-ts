/**
 * 协议基类（概念性，对齐上游 `protocols/base.py`）。
 *
 * 实际协议实现不强制继承 `Protocol`：MCP 走 transport 参考实现、
 * A2A 走 HTTP、ANP 走内存概念实现。
 */
export enum ProtocolType {
  MCP = 'mcp', // Model Context Protocol
  A2A = 'a2a', // Agent-to-Agent Protocol
  ANP = 'anp' // Agent Network Protocol
}

/**
 * 协议基类（概念性，不建议继承）。
 *
 * 上游标记为概念性，仅定义协议标识与版本信息；实际协议各自独立实现。
 */
export class Protocol {
  private readonly _protocolType: ProtocolType;
  private readonly _version: string;

  public constructor(protocolType: ProtocolType, version = '1.0.0') {
    this._protocolType = protocolType;
    this._version = version;
  }

  /** 获取协议名称（枚举值，如 `mcp`）。 */
  public get protocolName(): string {
    return this._protocolType.valueOf();
  }

  /** 获取协议版本。 */
  public get version(): string {
    return this._version;
  }

  public toString(): string {
    return `${this.constructor.name}(protocol=${this.protocolName}, version=${this.version})`;
  }
}
