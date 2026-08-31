{
  description = "Development environment for twitter-api-safe";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.stdenvNoCC.mkDerivation {
            pname = "pnpm";
            version = "11.5.0";

            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/pnpm/-/pnpm-11.5.0.tgz";
              hash = "sha256-ooKHFwj4eke5zXIYLf357iUcaRALi6yGKj1PXiFF2P8=";
            };

            nativeBuildInputs = [ pkgs.makeWrapper ];

            postPatch = ''
              rm -rf dist/node_modules/@reflink/reflink-*/reflink.*.node dist/vendor
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/bin" "$out/libexec/pnpm"
              cp -R . "$out/libexec/pnpm"
              makeWrapper ${nodejs}/bin/node "$out/bin/pnpm" \
                --add-flags "$out/libexec/pnpm/bin/pnpm.cjs"
              makeWrapper ${nodejs}/bin/node "$out/bin/pnpx" \
                --add-flags "$out/libexec/pnpm/bin/pnpx.cjs"

              runHook postInstall
            '';
          };
        in
        {
          default = pkgs.mkShellNoCC {
            packages = [
              nodejs
              pnpm
            ];
          };
        }
      );

      formatter = forAllSystems (system: (import nixpkgs { inherit system; }).nixfmt);
    };
}
