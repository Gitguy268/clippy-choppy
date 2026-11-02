<div align="center">

# Clippy Choppy

Clippy on your web page, in plain JavaScript.

</div>

An unofficial fan project, not affiliated with or endorsed by Microsoft. The Clippy character artwork in `assets/clippy/` belongs to its owner and is outside the MIT licence.

<!-- run-steps:start -->
## Run it locally, step by step

1. **Get the code:**

   ```sh
   git clone https://github.com/Gitguy268/clippy-choppy.git
   cd clippy-choppy
   ```

2. **Copy `clippy-choppy.js`, `style.css` and the `assets` folder** into your site.

3. **Add them to your page:**

   ```html
   <link rel="stylesheet" href="style.css">
   <script src="clippy-choppy.js"></script>
   ```

4. **Serve the folder,** because the animation data loads over HTTP:

   ```sh
   python3 -m http.server 8000
   ```

5. **Open <http://localhost:8000/>** in your browser.
<!-- run-steps:end -->

## Licence

See [LICENSE](LICENSE).
