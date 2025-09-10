#!/bin/bash

# Files needing getErrorMessage import
files_needing_getErrorMessage=(
    "src/middleware/workloadProxy.ts"
    "src/services/LLMGatewayService.ts" 
    "src/services/basicTaskDistribution.ts"
    "src/services/claudeCodeWrapper.ts"
    "src/utils/languageUtils.ts"
    "src/services/workerPool.ts"
    "src/services/workloadDistributor.ts"
)

# Files needing toError import
files_needing_toError=(
    "src/config/memory.ts"
    "src/services/cipherMemoryService.ts"
    "src/services/context7Cache.ts"
    "src/services/systemMonitor.ts"
    "src/services/vmstatMonitor.ts"
    "src/services/workerPool.ts"
    "src/services/workloadDistributor.ts"
)

# Get all unique files
all_files=($(printf '%s\n' "${files_needing_toError[@]}" "${files_needing_getErrorMessage[@]}" | sort -u))

for file in "${all_files[@]}"; do
    # Check if file exists
    if [[ ! -f "$file" ]]; then
        echo "Warning: $file not found"
        continue
    fi
    
    # Calculate relative path depth
    relPath=$(python3 -c "
import os, sys
f = sys.argv[1]
depth = len([x for x in os.path.dirname(f).split('/') if x])
print('../' * depth + 'utils/errorHandling')
" "$file")
    
    # Check what symbols this file needs
    needToError=""
    needGetMsg=""
    for check_file in "${files_needing_toError[@]}"; do
        if [[ "$check_file" == "$file" ]]; then
            needToError="yes"
            break
        fi
    done
    
    for check_file in "${files_needing_getErrorMessage[@]}"; do
        if [[ "$check_file" == "$file" ]]; then
            needGetMsg="yes"
            break
        fi
    done
    
    symbols=""
    [[ -n "$needToError" ]] && symbols="toError"
    [[ -n "$needGetMsg" ]] && symbols="${symbols:+$symbols, }getErrorMessage"
    [[ -z "$symbols" ]] && continue
    
    # Check if import already exists
    if ! grep -q "utils/errorHandling" "$file"; then
        echo "Adding import { $symbols } to $file (path: $relPath)"
        sed -i "1i import { $symbols } from '$relPath';" "$file"
    else
        echo "Import already exists in $file, skipping"
    fi
done

echo "Import fixes completed!"
