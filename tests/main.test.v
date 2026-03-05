// Tests for basic template
// Use @test-params to specify function parameters for testing.
// For non-void functions the last value is the expected result.
// Space-separated and JSON-array formats are both supported.
// Keep client/main.ts calls aligned with these starter semantics.

// @test-params 10 20 30
pub test_add(a: u64, b: u64) -> u64 {
    return a + b;
}

// @test-params 5 2 10
pub test_multiply(a: u64, b: u64) -> u64 {
    return a * b;
}

// @test-params
pub test_initialization() {
    log("Initialization test passed");
}
