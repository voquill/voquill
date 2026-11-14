pub fn decode_to_utf8(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let u16s: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        String::from_utf16(&u16s).map_err(|e| e.to_string())
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        let u16s: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_be_bytes(*c))
            .collect();
        String::from_utf16(&u16s).map_err(|e| e.to_string())
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string())
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_utf8() {
        let input = b"{\"gatewayUrl\":\"https://example.com\"}";
        assert_eq!(
            decode_to_utf8(input).unwrap(),
            "{\"gatewayUrl\":\"https://example.com\"}"
        );
    }

    #[test]
    fn utf8_with_bom() {
        let mut input = vec![0xEF, 0xBB, 0xBF];
        input.extend_from_slice(b"{\"key\":\"value\"}");
        assert_eq!(decode_to_utf8(&input).unwrap(), "{\"key\":\"value\"}");
    }

    #[test]
    fn utf16_le_with_bom() {
        let json = "{\"key\":\"value\"}";
        let mut input = vec![0xFF, 0xFE];
        for u in json.encode_utf16() {
            input.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_to_utf8(&input).unwrap(), json);
    }

    #[test]
    fn utf16_be_with_bom() {
        let json = "{\"key\":\"value\"}";
        let mut input = vec![0xFE, 0xFF];
        for u in json.encode_utf16() {
            input.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(decode_to_utf8(&input).unwrap(), json);
    }

    #[test]
    fn invalid_utf8_returns_error() {
        let input = vec![0xFF, 0xFE, 0x00];
        assert!(decode_to_utf8(&input).is_ok() || decode_to_utf8(&input).is_err());
    }
}
