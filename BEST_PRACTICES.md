# Claude Code WebUI - Best Practices

このドキュメントは、Claude Code WebUIの開発・運用における重要なベストプラクティスを記録しています。

## TUI/CLI統合における問題解決プロセス

### 問題の症状
- プロセスが正常に起動する（PIDが確認できる）
- コマンドがstdinに送信される
- しかし、stdoutから応答が返ってこない
- stderrにもエラーが出力されない

### 根本原因の特定プロセス

#### 1. 複数AIモデルによる壁打ち分析（CLAUDE.md準拠）
問題解決には必ず2つ以上のLLMモデルとの壁打ちを実施する：

1. **GPT-5による初回分析**: TTY要件の仮説を提示
2. **Gemini-2.5-Proによる検証**: 非対話モード調査の必要性を指摘  
3. **O3-Miniによる解決案**: 具体的実装アプローチを提供

#### 2. 仮説検証の手順
```bash
# 1. CLIのヘルプを確認
node /path/to/cli.js --help

# 2. 非対話モードの存在確認
# 期待する出力: --print, --output-format などのオプション

# 3. 非対話モードのテスト
node /path/to/cli.js --print "test command"
```

### 解決パターン：TUI → 非対話モード

#### Before: 対話型プロセス管理
```typescript
// 問題のあるアプローチ
const process = spawn(cliPath, [], {
  stdio: ['pipe', 'pipe', 'pipe']  // TTYなしでTUIを起動
});
process.stdin.write('command\n');  // TUIが応答しない
```

#### After: 非対話型コマンド実行
```typescript
// 解決されたアプローチ  
const process = spawn(cliPath, [
  '--print',           // 非対話モード
  command,             // コマンドを引数として渡す
  '--output-format', 'text'
], {
  stdio: ['pipe', 'pipe', 'pipe']  // 通常のパイプで動作
});
```

### アーキテクチャの変更

#### セッション管理の簡素化
```typescript
// Before: 永続プロセス管理
interface ProcessSession {
  process: ChildProcess | null;  // 削除
  // ...
}

// After: ステートレスセッション
interface ProcessSession {
  // process フィールドを削除
  sessionId: string;
  username: string;
  workingDir: string;
  // ...
}
```

#### コマンド実行の変更
```typescript
// Before: 永続プロセスへの入力送信
session.process.stdin?.write(`${command}\n`);

// After: コマンドごとに新プロセス起動
const process = spawn(cliPath, ['--print', command]);
```

## 技術的ベストプラクティス

### 1. CLI統合時の調査順序
1. `--help` でオプション確認
2. 非対話モード（`--print`, `--batch`, `--ci`）の有無確認
3. 出力フォーマット（`--output-format`, `--json`）の確認
4. TTY要件の検証

### 2. node-ptyを避けるべき理由
- 複雑性の増加
- プラットフォーム依存性
- セキュリティリスク
- デバッグの困難さ

### 3. エラーパターンの認識
```bash
# TTY要件のあるCLIの症状
echo "command" | cli-tool  # ハングアップまたは無応答
cli-tool < /dev/null       # 同様の症状

# 解決確認
cli-tool --print "command"  # 即座に出力
```

### 4. ログ分析の重要性
```log
# 問題のあるログパターン
Command execution requested  ✓
Executing command           ✓  
# この後に出力ログがない = TTY問題

# 正常なログパターン
Command execution requested  ✓
Executing command           ✓
Claude Code command completed ✓  # 出力あり
```

## セキュリティ考慮事項

### コマンドバリデーション
```typescript
// 危険なコマンドのブラックリスト方式採用
const dangerousCommands = ['rm', 'sudo', 'passwd', 'chmod', 'wget', 'curl'];
const firstWord = command.split(' ')[0].toLowerCase();
return !dangerousCommands.includes(firstWord);
```

### Unicode対応
```typescript
// 制御文字のみ置換、Unicodeは保持
.replace(/[\x00-\x1F\x7F]/g, '?');  // ASCII制御文字のみ
```

## 運用・保守

### 1. デバッグ手順
1. プロセス起動確認（`ps aux | grep cli`）
2. ログレベル確認（debug, info, error）
3. 手動コマンドテスト
4. 段階的な切り分け

### 2. モニタリングポイント
- セッション作成/終了率
- コマンド実行成功率  
- レスポンス時間
- エラー率とパターン

### 3. パフォーマンス最適化
- プロセス再利用からステートレス実行への移行
- セッション管理の簡素化
- 不要な永続状態の削除

## まとめ

TUI（Terminal User Interface）をWeb APIから制御する際は：

1. **まず非対話モードを探す** - `--print`, `--batch`, `--json`等
2. **TTY要件を前提としない** - node-ptyは最後の手段
3. **複数の視点で問題分析** - 壁打ちによる多角的検証
4. **ステートレス設計を優先** - 永続プロセス管理を避ける
5. **段階的な検証** - 手動テスト → 自動化

このアプローチにより、複雑なTTY管理を避けつつ、安定したCLI統合を実現できます。

---

*記録日: 2025-09-06*  
*問題解決チーム: Claude Code + GPT-5 + Gemini-2.5-Pro + O3-Mini*