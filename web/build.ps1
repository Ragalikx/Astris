param([switch]$Release, [switch]$Wasm64, [double]$CpuShare = 0.3)
$ErrorActionPreference='Stop'
Push-Location (Split-Path $PSScriptRoot -Parent)
$previousDevDebug=$env:CARGO_PROFILE_DEV_DEBUG
$previousRustFlags=$env:RUSTFLAGS
$previousBinaryenCores=$env:BINARYEN_CORES
$env:CARGO_PROFILE_DEV_DEBUG='0'
# Share of the CPU the build may use (default 30%): cargo's jobs and wasm-opt's threads,
# at below-normal priority so the machine stays usable. -CpuShare 1 builds at full speed.
$jobs = [math]::Max(1, [math]::Floor([Environment]::ProcessorCount * $CpuShare))
$env:BINARYEN_CORES = "$jobs"
try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}
Write-Host "Build: $jobs of $([Environment]::ProcessorCount) logical cores"
$profileName = if($Release){'browser-release'}else{'browser'}
$targetArch = if($Wasm64){'wasm64-unknown-unknown'}else{'wasm32-unknown-unknown'}
$targetDir = if($Wasm64){'target/browser64'}else{'target/browser'}
$outDir = if($Wasm64){'web/pkg64'}else{'web/pkg'}
try {
 $simd = if($Release){' -C target-feature=+simd128'}else{''}
 $maxMem = if($Wasm64){'17179869184'}else{'4294967296'}
 $extra64 = if($Wasm64){' -Zcrate-attr=feature(simd_wasm64) --cfg getrandom_backend="custom"'}else{''}
 $env:RUSTFLAGS='-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory='+$maxMem+$simd+$extra64
 # The nightly toolchain, or a pinned one from RUST_TOOLCHAIN (the deploy workflow sets it).
 $toolchain = if($env:RUST_TOOLCHAIN){$env:RUST_TOOLCHAIN}else{'nightly'}
 cargo "+$toolchain" rustc -p horizon-client --bin horizon-client --target $targetArch --profile $profileName --target-dir $targetDir -j $jobs -Z build-std=std,panic_abort --no-default-features --features audio --locked -- -C link-arg=-zstack-size=8388608 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base
 if($LASTEXITCODE -ne 0){throw 'WASM compilation failed'}
 wasm-bindgen "$targetDir/$targetArch/$profileName/horizon-client.wasm" --target web --out-dir $outDir --out-name horizon_client
 if($LASTEXITCODE -ne 0){throw 'wasm-bindgen failed'}
 if($Release){
  # wasm-opt from $env:WASM_OPT, PATH, or a Binaryen release unpacked in %LOCALAPPDATA%\binaryen.
  $wasmOpt = $env:WASM_OPT
  if(-not $wasmOpt){ $wasmOpt = (Get-Command wasm-opt -ErrorAction SilentlyContinue).Source }
  if(-not $wasmOpt){ $wasmOpt = Get-ChildItem "$env:LOCALAPPDATA\binaryen\*\bin\wasm-opt.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1 -ExpandProperty FullName }
  if($wasmOpt){
   $wasm="$outDir/horizon_client_bg.wasm"
   $features = @('--enable-threads','--enable-bulk-memory','--enable-simd','--enable-mutable-globals','--enable-sign-ext','--enable-nontrapping-float-to-int','--enable-reference-types','--enable-multivalue')
   if($Wasm64){ $features += '--enable-memory64' }
   $before = (Get-Item $wasm).Length
   # -g keeps the function names: a crash in the browser then names the Rust function
   # instead of wasm-function[14702]. About 3.7 MB more, around 1 MB over the network.
   & $wasmOpt -O3 -g @features $wasm -o $wasm
   if($LASTEXITCODE -ne 0){throw 'wasm-opt failed'}
   Write-Host ("wasm-opt: {0:N1} MB -> {1:N1} MB" -f ($before/1MB), ((Get-Item $wasm).Length/1MB))
  } else { Write-Warning 'wasm-opt (Binaryen) not found; skipping size/speed pass' }
 }
}finally{$env:CARGO_PROFILE_DEV_DEBUG=$previousDevDebug;$env:RUSTFLAGS=$previousRustFlags;$env:BINARYEN_CORES=$previousBinaryenCores;Pop-Location}
