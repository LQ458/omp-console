use std::path::Path;

use url::{Url, form_urlencoded};

const MAX_SESSION_ID_LENGTH: usize = 128;
const MAX_CWD_LENGTH: usize = 4096;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum DeepLink {
	Session { id: String },
	New { cwd: String },
}

impl DeepLink {
	pub(crate) fn hash_fragment(&self) -> String {
		let mut form = form_urlencoded::Serializer::new(String::new());
		match self {
			Self::Session { id } => form.append_pair("session", id),
			Self::New { cwd } => form.append_pair("new", cwd),
		};
		form.finish()
	}
}

pub(crate) fn parse(input: &str) -> Option<DeepLink> {
	if input.trim() != input {
		return None;
	}
	let url = Url::parse(input).ok()?;
	if url.scheme() != "omp-console"
		|| has_userinfo(input)
		|| !url.username().is_empty()
		|| url.password().is_some()
		|| url.port().is_some()
		|| url.fragment().is_some()
	{
		return None;
	}

	match url.host_str()? {
		"session" => {
			if url.query().is_some() {
				return None;
			}
			let encoded_id = raw_path(input)?.strip_prefix('/')?;
			if encoded_id.is_empty() || encoded_id.contains('/') {
				return None;
			}
			let id = decode_component(encoded_id, false)?;
			if id.is_empty()
				|| id.len() > MAX_SESSION_ID_LENGTH
				|| id.trim() != id
				|| id.contains('/')
				|| id.contains('\\')
				|| id.chars().any(char::is_control)
			{
				return None;
			}
			Some(DeepLink::Session { id })
		},
		"new" => {
			if !matches!(url.path(), "" | "/") || url.query().is_none() {
				return None;
			}
			let raw_query = input.split_once('?')?.1;
			let (key, encoded_cwd) = raw_query.split_once('=')?;
			if key != "cwd" || encoded_cwd.is_empty() || encoded_cwd.contains('&') {
				return None;
			}
			let cwd = decode_component(encoded_cwd, true)?;
			if cwd.is_empty()
				|| cwd.len() > MAX_CWD_LENGTH
				|| cwd.contains('\0')
				|| !Path::new(&cwd).is_absolute()
			{
				return None;
			}
			Some(DeepLink::New { cwd })
		},
		_ => None,
	}
}

fn has_userinfo(input: &str) -> bool {
	let Some((_, after_scheme)) = input.split_once("://") else {
		return true;
	};
	let authority = after_scheme
		.split(|character| matches!(character, '/' | '?' | '#'))
		.next()
		.unwrap_or_default();
	authority.contains('@')
}

fn raw_path(input: &str) -> Option<&str> {
	let after_scheme = input.split_once("://")?.1;
	let start = after_scheme.find('/')?;
	after_scheme[start..]
		.split(|character| matches!(character, '?' | '#'))
		.next()
}

fn decode_component(encoded: &str, plus_as_space: bool) -> Option<String> {
	let bytes = encoded.as_bytes();
	let mut decoded = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		match bytes[index] {
			b'%' => {
				let high = hex_value(*bytes.get(index + 1)?)?;
				let low = hex_value(*bytes.get(index + 2)?)?;
				decoded.push((high << 4) | low);
				index += 3;
			},
			b'+' if plus_as_space => {
				decoded.push(b' ');
				index += 1;
			},
			byte => {
				decoded.push(byte);
				index += 1;
			},
		}
	}
	String::from_utf8(decoded).ok()
}

fn hex_value(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::{DeepLink, parse};

	#[test]
	fn session_links_decode_one_safe_id_and_build_the_web_fragment() {
		let link = parse("omp-console://session/test-id").expect("session deep link should parse");
		assert_eq!(link, DeepLink::Session { id: "test-id".to_string() });
		assert_eq!(link.hash_fragment(), "session=test-id");
	}

	#[test]
	fn session_links_reject_invalid_ids_and_extra_url_parts() {
		for input in [
			"omp-console://session/",
			"omp-console://session/a%2Fb",
			"omp-console://session/a%5Cb",
			"omp-console://session/a?extra=1",
			"omp-console://session/a#fragment",
			"omp-console://session/%FF",
			"omp-console://session/%ZZ",
			"omp-console://session/a/child",
			"omp-console://@session/a",
			"omp-console://session:123/a",
		] {
			assert!(parse(input).is_none(), "unexpectedly accepted {input}");
		}
	}

	#[test]
	fn new_session_links_decode_and_reencode_absolute_paths() {
		let link = parse("omp-console://new?cwd=%2FUsers%2Falice%2FProjects%2Fomp-console%2Btest")
			.expect("encoded absolute cwd should parse");
		assert_eq!(link, DeepLink::New { cwd: "/Users/alice/Projects/omp-console+test".to_string() });
		assert_eq!(link.hash_fragment(), "new=%2FUsers%2Falice%2FProjects%2Fomp-console%2Btest");
	}

	#[test]
	fn new_session_links_reject_other_schemes_and_malformed_paths() {
		for input in [
			"https://new?cwd=%2Ftmp",
			"omp-console+other://new?cwd=%2Ftmp",
			"omp-console://other?cwd=%2Ftmp",
			"omp-console://new",
			"omp-console://new?cwd=",
			"omp-console://new?cwd=relative/path",
			"omp-console://new?cwd=%2Ftmp&cwd=%2Fother",
			"omp-console://new?cwd=%2Ftmp#fragment",
			"omp-console://new/extra?cwd=%2Ftmp",
			"omp-console://new?cwd=%2Fbad%ZZ",
			"omp-console://new?cwd=%FF",
		] {
			assert!(parse(input).is_none(), "unexpectedly accepted {input}");
		}
	}
}
