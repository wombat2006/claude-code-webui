# S3 RAG解析ツール利用ガイド

## 概要

Claude Code WebUIの分散状態管理システムに統合されたS3 RAGサービスは、コード解析結果、ドキュメント、会話履歴を効率的に保存・検索する機能を提供します。Context7との連携により、設計時に必要なリファレンス情報の収集・活用も可能です。

## 主要機能

### 1. ドキュメント保存・検索
- **コード解析結果**: ファイル解析、パフォーマンス分析、セキュリティ監査結果
- **技術文書**: API仕様書、設計書、ベストプラクティス
- **会話履歴**: Claude Codeとのやり取り、問題解決プロセス
- **ログデータ**: エラーログ、デバッグ情報、システム状態

### 2. Context7統合
- **リファレンス収集**: 設計に必要な技術資料の自動収集
- **キャッシュ機能**: 一度収集したリファレンスの効率的な再利用
- **パターン検索**: 設計パターン、ベストプラクティスの検索

## API エンドポイント

### 基本認証
すべてのエンドポイントでJWT認証が必要です。
```
Authorization: Bearer <your-jwt-token>
```

### 1. ドキュメント検索
```
GET /api/rag/search?query=<検索クエリ>&type=<ドキュメントタイプ>&limit=10
```

**パラメータ:**
- `query` (必須): 検索クエリ文字列
- `type` (オプション): `code|documentation|log|conversation|analysis`
- `project` (オプション): プロジェクト名
- `tags` (オプション): タグフィルター
- `limit` (オプション): 結果件数上限 (デフォルト: 10)
- `similarity_threshold` (オプション): 類似度閾値 (デフォルト: 0.1)

**レスポンス例:**
```json
{
  "query": "React hooks performance",
  "results": [
    {
      "id": "analysis_abc123_1672531200000",
      "title": "React Hooks Performance Analysis",
      "excerpt": "useCallback and useMemo optimization patterns...",
      "similarity": 0.87,
      "type": "analysis",
      "source": "src/components/HookExample.tsx",
      "project": "my-react-app",
      "tags": ["react", "hooks", "performance"],
      "createdAt": 1672531200000
    }
  ],
  "totalResults": 1,
  "timestamp": 1672617600000
}
```

### 2. ドキュメント取得
```
GET /api/rag/documents/<documentId>
```

### 3. ドキュメント保存
```
POST /api/rag/documents
Content-Type: application/json

{
  "title": "React Performance Guidelines",
  "content": "詳細なドキュメント内容...",
  "metadata": {
    "type": "documentation",
    "source": "internal-wiki",
    "language": "javascript",
    "project": "my-react-app",
    "tags": ["react", "performance", "guidelines"]
  }
}
```

### 4. コード解析結果保存
```
POST /api/rag/code-analysis
Content-Type: application/json

{
  "filePath": "src/components/UserProfile.tsx",
  "codeContent": "import React from 'react'...",
  "analysisResult": {
    "complexity": 8,
    "issues": ["unused-import", "performance-warning"],
    "suggestions": ["Use React.memo for optimization"]
  },
  "project": "user-management-app"
}
```

## Context7統合機能

### 1. リファレンス収集
```
POST /api/rag/references/collect
Content-Type: application/json

{
  "query": "React TypeScript best practices",
  "type": "best-practice",
  "language": "typescript",
  "framework": "react",
  "project": "my-project"
}
```

**リファレンスタイプ:**
- `library`: ライブラリのドキュメント
- `framework`: フレームワークの使用方法
- `pattern`: 設計パターン
- `best-practice`: ベストプラクティス
- `api-reference`: API仕様書

### 2. 設計パターン検索
```
GET /api/rag/references/patterns/observer?language=typescript
```

### 3. ライブラリリファレンス
```
GET /api/rag/references/libraries/react?version=18
```

### 4. ベストプラクティス取得
```
GET /api/rag/references/best-practices/react?context=performance
```

## 使用例

### シナリオ1: コード解析結果の保存と活用

1. **解析結果保存:**
```bash
curl -X POST http://localhost:3001/api/rag/code-analysis \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "filePath": "src/hooks/useUserData.ts",
    "codeContent": "export const useUserData = () => {...}",
    "analysisResult": {
      "performance": {
        "score": 85,
        "issues": ["missing-memoization"],
        "suggestions": ["Consider using useMemo for expensive calculations"]
      }
    }
  }'
```

2. **類似問題の検索:**
```bash
curl "http://localhost:3001/api/rag/search?query=useMemo+performance&type=analysis" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### シナリオ2: 設計時のリファレンス活用

1. **React設計パターンの調査:**
```bash
curl -X POST http://localhost:3001/api/rag/references/collect \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "React component composition patterns",
    "type": "pattern",
    "language": "typescript",
    "framework": "react"
  }'
```

2. **保存されたパターンの検索:**
```bash
curl "http://localhost:3001/api/rag/references/search?query=composition&category=patterns" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

## コスト効率化のヒント

### 1. 適切なドキュメント分類
```javascript
const metadata = {
  type: "analysis", // 正確なタイプ分類
  tags: ["react", "hooks", "performance"], // 具体的なタグ
  project: "user-dashboard", // プロジェクト分類
  source: filePath // ソース情報
};
```

### 2. 定期的なクリーンアップ
```bash
# 30日以上古いドキュメントを削除
curl -X POST "http://localhost:3001/api/rag/cleanup?daysOld=30&context7DaysOld=7" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

### 3. 効率的な検索
```bash
# プロジェクト・タグフィルターを活用
curl "http://localhost:3001/api/rag/search?query=performance&project=my-app&tags=react,optimization&limit=5" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

## 統計・監視

### システム統計取得
```bash
curl "http://localhost:3001/api/rag/statistics" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

**レスポンス例:**
```json
{
  "rag": {
    "totalDocuments": 1247,
    "totalSizeBytes": 15728640,
    "documentsByType": {
      "analysis": 456,
      "documentation": 321,
      "conversation": 289,
      "code": 181
    },
    "averageDocumentSize": 12622
  },
  "context7": {
    "totalCachedReferences": 89,
    "referencesByType": {
      "best-practice": 34,
      "library": 28,
      "pattern": 15,
      "api-reference": 12
    },
    "averageReferenceAge": 432000000
  }
}
```

## セキュリティ考慮事項

1. **認証**: 全APIエンドポイントでJWT認証必須
2. **レート制限**: 検索30回/分、アップロード20回/5分
3. **暗号化**: S3サーバーサイド暗号化 (AES-256)
4. **監査ログ**: 全操作がCloudWatchに記録

## トラブルシューティング

### よくあるエラー

1. **401 Unauthorized**
   - JWTトークンの確認・更新

2. **429 Too Many Requests**
   - レート制限に達した場合は時間をおいて再試行

3. **400 Bad Request**
   - 必須パラメータの確認
   - JSON形式の確認

4. **500 Internal Server Error**
   - サーバーログの確認
   - AWSサービス状態の確認

### デバッグ用コマンド

```bash
# ヘルスチェック
curl "http://localhost:3001/api/health" \
  -H "Authorization: Bearer $JWT_TOKEN"

# 接続テスト
curl "http://localhost:3001/api/rag/statistics" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

このRAGシステムにより、Claude Code WebUIでの開発作業がより効率的になり、過去の知見を活用した高品質なコード開発が可能になります。