This package contains an internal package under the folder `rust-client`, which is just the Rust library and its auto-generated TS code. The external package, in this folder, contains all wrapping TS code and tests.

### First time install
Homebrew is the easiest way to install node, but you can choose any way you want to install it.
Npm should come as part as node.
Use npm to install yarn globaly - `npm install -g yarn` 
run `npm run initial-build`.

### Build

Run `npm run build-internal` to build the internal package and generates TS code. `npm run build-external` builds the external package without rebuilding the internal package.
Run `npm run build` runs a full build.

### Compile protobuf files

Run `npm install protobufjs-cli` to install the JS protobuf command line utility
Generate static JS code `pbjs -t static-module -o compiled.js ~/babushka/rust/babushkapb/src/proto/babushkaproto.proto`
Generates TS definitions from the compiled JS file `pbts -o compiled.d.ts compiled.js`

### Testing

Run `npm test` after building.
