#[cfg(test)]
mod tests {
    use printninja_lib::render::raster::RasterImage;

    #[test]
    fn test_raster_image_creation() {
        let img = RasterImage::new(8, 8);
        assert_eq!(img.width, 8);
        assert_eq!(img.height, 8);
        assert_eq!(img.dots.len(), 8); // 1 byte per row * 8 rows
    }

    #[test]
    fn test_raster_set_get_bit() {
        let mut img = RasterImage::new(8, 8);
        img.set_bit(0, 0, true);
        img.set_bit(7, 0, true);
        img.set_bit(3, 4, true);
        assert!(img.get_bit(0, 0));
        assert!(img.get_bit(7, 0));
        assert!(img.get_bit(3, 4));
        assert!(!img.get_bit(0, 1));
        assert!(!img.get_bit(7, 1));
    }

    #[test]
    fn test_raster_bit_packing() {
        let mut img = RasterImage::new(8, 1);
        img.set_bit(0, 0, true);
        img.set_bit(1, 0, true);
        img.set_bit(2, 0, true);
        // First 3 bits set: 0b11100000 = 0xE0
        assert_eq!(img.dots[0], 0xE0);
    }

    #[test]
    fn test_raster_out_of_bounds() {
        let mut img = RasterImage::new(8, 8);
        // Should not panic
        img.set_bit(100, 100, true);
        assert!(!img.get_bit(100, 100));
    }

    #[test]
    fn test_floyd_steinberg() {
        let grayscale = vec![0u8; 16];
        let mut raster_img = RasterImage::new(4, 4);
        raster_img.floyd_steinberg(&grayscale, 4, 4);
        // All black pixels should result in all bits set
        assert_eq!(raster_img.dots, vec![0xF0; 4]);
    }
}
