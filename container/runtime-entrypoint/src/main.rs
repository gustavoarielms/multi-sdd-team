use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{self, Command};

const CODEX_BINARY: &str = "/opt/openai/codex-app-server/bin/codex-app-server";
const CODEX_HOME: &str = "/run/codex";
const MANAGED_ROOT: &str = "/workspace/.codex";
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PROMPT_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROMPTS: usize = 64;
const O_NOFOLLOW: i32 = 0x20000;

fn main() {
    if run().is_err() {
        eprintln!("runtime-entrypoint: startup failed");
        process::exit(2);
    }
}

fn run() -> io::Result<()> {
    require_fixed_arguments()?;
    let prompt_digest = managed_prompt_digest()?;
    let codex_digest = sha256_file(Path::new(CODEX_BINARY), 256 * 1024 * 1024)?;
    write_ephemeral_config()?;
    let attestation = format!(
        "{{\"codexArtifactSha256\":\"sha256:{codex_digest}\",\"codexVersion\":\"0.154.0\",\"contractVersion\":\"1\",\"platform\":\"linux/arm64\",\"promptSnapshotSha256\":\"sha256:{prompt_digest}\",\"schemaVersion\":\"1.0.0\"}}\n"
    );
    if attestation.len() > 512 {
        return Err(io::Error::other("attestation bound"));
    }
    io::stdout().write_all(attestation.as_bytes())?;
    io::stdout().flush()?;
    let error = Command::new(CODEX_BINARY)
        .args(["--listen", "stdio://"])
        .env("HOME", CODEX_HOME)
        .env("CODEX_HOME", CODEX_HOME)
        .exec();
    Err(error)
}

fn require_fixed_arguments() -> io::Result<()> {
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    let expected = [OsString::from("--listen"), OsString::from("stdio://")];
    if arguments != expected {
        return Err(io::Error::other("invalid arguments"));
    }
    Ok(())
}

fn write_ephemeral_config() -> io::Result<()> {
    let path = Path::new(CODEX_HOME).join("config.toml");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(O_NOFOLLOW)
        .open(path)?;
    file.write_all(b"cli_auth_credentials_store = \"ephemeral\"\n")?;
    file.flush()
}

fn managed_prompt_digest() -> io::Result<String> {
    let root = Path::new(MANAGED_ROOT);
    let manifest = read_bounded(&root.join("managed-prompts.json"), MAX_FILE_BYTES)?;
    let mut prompt_paths = Vec::new();
    for entry in fs::read_dir(root.join("agents"))? {
        let entry = entry?;
        let name = entry.file_name().into_string().map_err(|_| io::Error::other("name"))?;
        if !safe_prompt_name(&name) || !entry.file_type()?.is_file() {
            return Err(io::Error::other("prompt inventory"));
        }
        prompt_paths.push(format!("agents/{name}"));
    }
    prompt_paths.sort();
    if prompt_paths.is_empty() || prompt_paths.len() > MAX_PROMPTS {
        return Err(io::Error::other("prompt count"));
    }
    let mut total = manifest.len() as u64;
    let mut digest = Sha256::new();
    update_record(&mut digest, b"manifest", &manifest);
    for relative in prompt_paths {
        total = total.checked_add(relative.len() as u64).ok_or_else(|| io::Error::other("size"))?;
        if total > MAX_PROMPT_BYTES {
            return Err(io::Error::other("prompt size"));
        }
        let content = read_bounded(&root.join(&relative), (MAX_PROMPT_BYTES - total).min(MAX_FILE_BYTES))?;
        total = total.checked_add(content.len() as u64).ok_or_else(|| io::Error::other("size"))?;
        update_record(&mut digest, b"prompt-path", relative.as_bytes());
        update_record(&mut digest, b"prompt-content", &content);
    }
    Ok(hex(&digest.finalize()))
}

fn safe_prompt_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".toml") else { return false };
    !stem.is_empty() && stem.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}

fn read_bounded(path: &Path, maximum: u64) -> io::Result<Vec<u8>> {
    let before_path = fs::symlink_metadata(path)?;
    if !before_path.file_type().is_file() || before_path.file_type().is_symlink() || before_path.len() > maximum {
        return Err(io::Error::other("unsafe file"));
    }
    let mut file = OpenOptions::new().read(true).custom_flags(O_NOFOLLOW).open(path)?;
    let before = file.metadata()?;
    let mut bytes = Vec::with_capacity((before.len().min(maximum)) as usize);
    Read::by_ref(&mut file).take(maximum + 1).read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    let after_path = fs::symlink_metadata(path)?;
    if bytes.len() as u64 > maximum || !same_file(&before, &after) || !same_file(&after, &after_path) {
        return Err(io::Error::other("unstable file"));
    }
    Ok(bytes)
}

fn same_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    left.dev() == right.dev()
        && left.ino() == right.ino()
        && left.len() == right.len()
        && left.mtime() == right.mtime()
        && left.mtime_nsec() == right.mtime_nsec()
        && left.ctime() == right.ctime()
        && left.ctime_nsec() == right.ctime_nsec()
}

fn sha256_file(path: &Path, maximum: u64) -> io::Result<String> {
    let bytes = read_bounded(path, maximum)?;
    let mut digest = Sha256::new();
    digest.update(&bytes);
    Ok(hex(&digest.finalize()))
}

fn update_record(digest: &mut Sha256, record_type: &[u8], value: &[u8]) {
    digest.update(&(record_type.len() as u32).to_be_bytes());
    digest.update(record_type);
    digest.update(&(value.len() as u64).to_be_bytes());
    digest.update(value);
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        value.push(DIGITS[(byte >> 4) as usize] as char);
        value.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    value
}

struct Sha256 {
    state: [u32; 8],
    buffer: [u8; 64],
    buffer_len: usize,
    byte_len: u64,
}

impl Sha256 {
    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buffer: [0; 64],
            buffer_len: 0,
            byte_len: 0,
        }
    }

    fn update(&mut self, mut input: &[u8]) {
        self.byte_len = self.byte_len.checked_add(input.len() as u64).expect("bounded input");
        if self.buffer_len != 0 {
            let needed = 64 - self.buffer_len;
            let take = needed.min(input.len());
            self.buffer[self.buffer_len..self.buffer_len + take].copy_from_slice(&input[..take]);
            self.buffer_len += take;
            input = &input[take..];
            if self.buffer_len < 64 {
                return;
            }
            let block = self.buffer;
            self.compress(&block);
            self.buffer_len = 0;
        }
        while input.len() >= 64 {
            let block: &[u8; 64] = input[..64].try_into().expect("block");
            self.compress(block);
            input = &input[64..];
        }
        self.buffer[..input.len()].copy_from_slice(input);
        self.buffer_len = input.len();
    }

    fn finalize(mut self) -> [u8; 32] {
        let bit_len = self.byte_len.checked_mul(8).expect("bounded input");
        self.buffer[self.buffer_len] = 0x80;
        self.buffer_len += 1;
        if self.buffer_len > 56 {
            self.buffer[self.buffer_len..].fill(0);
            let block = self.buffer;
            self.compress(&block);
            self.buffer = [0; 64];
            self.buffer_len = 0;
        }
        self.buffer[self.buffer_len..56].fill(0);
        self.buffer[56..].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress(&block);
        let mut output = [0; 32];
        for (chunk, word) in output.chunks_exact_mut(4).zip(self.state) {
            chunk.copy_from_slice(&word.to_be_bytes());
        }
        output
    }

    fn compress(&mut self, block: &[u8; 64]) {
        const K: [u32; 64] = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
        ];
        let mut schedule = [0u32; 64];
        for (index, chunk) in block.chunks_exact(4).enumerate() {
            schedule[index] = u32::from_be_bytes(chunk.try_into().expect("word"));
        }
        for index in 16..64 {
            let s0 = schedule[index - 15].rotate_right(7) ^ schedule[index - 15].rotate_right(18) ^ (schedule[index - 15] >> 3);
            let s1 = schedule[index - 2].rotate_right(17) ^ schedule[index - 2].rotate_right(19) ^ (schedule[index - 2] >> 10);
            schedule[index] = schedule[index - 16].wrapping_add(s0).wrapping_add(schedule[index - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = self.state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let first = h.wrapping_add(s1).wrapping_add(choice).wrapping_add(K[index]).wrapping_add(schedule[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let second = s0.wrapping_add(majority);
            h = g; g = f; f = e; e = d.wrapping_add(first); d = c; c = b; b = a; a = first.wrapping_add(second);
        }
        for (state, value) in self.state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *state = state.wrapping_add(value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{hex, safe_prompt_name, Sha256};

    #[test]
    fn sha256_matches_known_vector() {
        let mut digest = Sha256::new();
        digest.update(b"abc");
        assert_eq!(
            hex(&digest.finalize()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    #[test]
    fn sha256_matches_known_vector_across_updates() {
        let mut digest = Sha256::new();
        digest.update(b"a");
        digest.update(b"b");
        digest.update(b"c");
        assert_eq!(
            hex(&digest.finalize()),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
    }

    #[test]
    fn prompt_names_are_closed() {
        assert!(safe_prompt_name("implementer.toml"));
        assert!(!safe_prompt_name("../implementer.toml"));
        assert!(!safe_prompt_name("nested/implementer.toml"));
        assert!(!safe_prompt_name("secret.txt"));
    }
}
