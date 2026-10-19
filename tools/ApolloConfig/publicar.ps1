# Gera a janela R3D PLAY autocontida (não exige .NET instalado) em tools/ApolloConfig/publish.
Push-Location $PSScriptRoot
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -o publish
Pop-Location
