#[test_only]
module chaingammon::version_tests {
    use chaingammon::version;

    #[test]
    fun package_version_is_one() {
        assert!(version::package_version() == 1, 0);
    }
}
