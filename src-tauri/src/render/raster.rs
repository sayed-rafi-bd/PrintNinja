/// Represents a 1-bit raster image for thermal printing
#[derive(Debug, Clone)]
pub struct RasterImage {
    pub width: usize,
    pub height: usize,
    pub dots: Vec<u8>, // 1 bit per pixel, packed into bytes (8 pixels per byte)
}

impl RasterImage {
    pub fn new(width: usize, height: usize) -> Self {
        let bytes_per_row = width.div_ceil(8);
        Self {
            width,
            height,
            dots: vec![0u8; bytes_per_row * height],
        }
    }

    pub fn get_bit(&self, x: usize, y: usize) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let idx = y * self.width.div_ceil(8) + (x / 8);
        let bit = 7 - (x % 8);
        (self.dots[idx] >> bit) & 1 == 1
    }

    pub fn set_bit(&mut self, x: usize, y: usize, value: bool) {
        if x >= self.width || y >= self.height {
            return;
        }
        let idx = y * self.width.div_ceil(8) + (x / 8);
        let bit = 7 - (x % 8);
        if value {
            self.dots[idx] |= 1 << bit;
        } else {
            self.dots[idx] &= !(1 << bit);
        }
    }

    /// Apply threshold: convert grayscale to 1-bit
    pub fn threshold(&mut self, grayscale: &[u8], width: usize, height: usize, threshold: u8) {
        for y in 0..height {
            for x in 0..width {
                let idx = y * width + x;
                if idx < grayscale.len() {
                    self.set_bit(x, y, grayscale[idx] < threshold);
                }
            }
        }
    }

    /// Floyd-Steinberg dithering for better tonal reproduction
    pub fn floyd_steinberg(&mut self, grayscale: &[u8], width: usize, height: usize) {
        let mut pixels: Vec<i32> = grayscale.iter().map(|&v| v as i32).collect();

        for y in 0..height {
            for x in 0..width {
                let idx = y * width + x;
                if idx >= pixels.len() {
                    continue;
                }
                let old = pixels[idx];
                let new = if old < 128 { 0i32 } else { 255i32 };
                self.set_bit(x, y, old < 128);
                let err = old - new;

                if x + 1 < width {
                    pixels[idx + 1] = (pixels[idx + 1] + err * 7 / 16).clamp(0, 255);
                }
                if y + 1 < height && x > 0 {
                    pixels[idx + width - 1] =
                        (pixels[idx + width - 1] + err * 3 / 16).clamp(0, 255);
                }
                if y + 1 < height {
                    pixels[idx + width] = (pixels[idx + width] + err * 5 / 16).clamp(0, 255);
                }
                if y + 1 < height && x + 1 < width {
                    pixels[idx + width + 1] = (pixels[idx + width + 1] + err / 16).clamp(0, 255);
                }
            }
        }
    }

    /// Pack into bytes for sending to printer
    pub fn to_bytes(&self) -> Vec<u8> {
        self.dots.clone()
    }

    /// Scale image to target width maintaining aspect ratio
    pub fn scale_to_width(&mut self, target_width: usize) {
        if target_width == self.width {
            return;
        }
        let scale = target_width as f64 / self.width as f64;
        let new_height = (self.height as f64 * scale) as usize;
        let new_height = new_height.max(1);

        // Nearest neighbor scaling
        let new_bytes_per_row = target_width.div_ceil(8);
        let mut new_dots = vec![0u8; new_bytes_per_row * new_height];

        for y in 0..new_height {
            for x in 0..target_width {
                let src_x = (x as f64 / scale) as usize;
                let src_y = (y as f64 / scale) as usize;
                let src_idx = src_y * self.width.div_ceil(8) + (src_x / 8);
                let src_bit = 7 - (src_x % 8);

                if src_x < self.width && src_y < self.height {
                    let bit = (self.dots[src_idx] >> src_bit) & 1;
                    let new_idx = y * new_bytes_per_row + (x / 8);
                    let new_bit = 7 - (x % 8);
                    if bit == 1 {
                        new_dots[new_idx] |= 1 << new_bit;
                    }
                }
            }
        }

        self.width = target_width;
        self.height = new_height;
        self.dots = new_dots;
    }
}

/// Thermal printer dot widths by paper size
pub fn dot_width_for_paper(paper_mm: usize) -> usize {
    match paper_mm {
        58 => 384,
        80 => 576,
        100 => 820,
        _ => 384,
    }
}
